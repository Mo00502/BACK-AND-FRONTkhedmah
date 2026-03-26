import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../prisma/prisma.service';
import { QuoteStatus, PaymentMethod, RequestStatus, Prisma } from '@prisma/client';
import { MaterialsPaymentService } from '../materials-payment/materials-payment.service';
import axios from 'axios';
import * as crypto from 'crypto';

interface MoyasarWebhookPayload {
  type: string;
  id?: string;
  data: {
    id: string;
    status: string;
    amount: number;
    metadata?: Record<string, any>;
    [key: string]: any;
  };
}

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  private readonly moyasarBase = 'https://api.moyasar.com/v1';

  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
    private events: EventEmitter2,
    private materials: MaterialsPaymentService,
  ) {}

  /**
   * Initiate a Moyasar payment for a service request.
   * Supports both service-only and service+materials order types.
   *
   * hasMaterials=true triggers a split:
   *   total charge = serviceAmount + materialsEstimate
   *   Both amounts are stored on the Payment record before the charge.
   */
  async initiatePayment(
    customerId: string,
    requestId: string,
    method: string,
    hasMaterials = false,
    materialsEstimate = 0,
  ) {
    const request = await this.prisma.serviceRequest.findUnique({
      where: { id: requestId },
      include: { quotes: { where: { status: QuoteStatus.ACCEPTED } } },
    });

    if (!request) throw new NotFoundException('Request not found');
    if (request.customerId !== customerId) throw new ForbiddenException('Not your request');
    if (request.status !== 'ACCEPTED')
      throw new BadRequestException('Request must be in ACCEPTED status');

    const quote = request.quotes[0];
    if (!quote) throw new BadRequestException('No accepted quote found');

    if (hasMaterials && materialsEstimate <= 0) {
      throw new BadRequestException('materialsEstimate must be > 0 when hasMaterials is true');
    }

    // Validate materialsEstimate against what was agreed in the request (allow ±20% tolerance)
    if (hasMaterials && request.materialsEstimate) {
      const agreed = Number(request.materialsEstimate);
      const tolerance = agreed * 0.2;
      if (Math.abs(materialsEstimate - agreed) > tolerance) {
        throw new BadRequestException(
          `materialsEstimate ${materialsEstimate} deviates >20% from agreed estimate ${agreed}`,
        );
      }
    }

    const serviceAmount = Number(quote.amount);
    const materialsAmount = hasMaterials ? materialsEstimate : 0;
    const totalAmount = serviceAmount + materialsAmount;

    // Atomic check-then-create inside a serializable transaction to prevent two concurrent
    // requests from both passing the "no existing payment" check and creating duplicate payments.
    let payment: Awaited<ReturnType<typeof this.prisma.payment.create>>;
    try {
      payment = await this.prisma.$transaction(
        async (tx) => {
          const existing = await tx.payment.findFirst({
            where: { requestId, status: { in: ['PENDING', 'PAID'] } },
          });
          if (existing) throw new ConflictException('Payment already initiated for this request');

          return tx.payment.create({
            data: {
              requestId,
              amount: totalAmount,
              serviceAmount,
              materialsAmount,
              method: method as PaymentMethod,
              status: 'PENDING',
            },
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (err) {
      if (err instanceof ConflictException) throw err;
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('Payment already initiated for this request');
      }
      throw err;
    }

    // Save order type & estimate back to the ServiceRequest
    if (hasMaterials) {
      await this.prisma.serviceRequest.update({
        where: { id: requestId },
        data: {
          orderType: 'SERVICE_WITH_MATERIALS',
          hasMaterials: true,
          materialsEstimate,
        },
      });
    }

    const moyasarPayload = {
      amount: Math.round(totalAmount * 100), // SAR → halalas
      currency: 'SAR',
      description: hasMaterials
        ? `Khedmah — خدمة + مواد | طلب ${requestId}`
        : `Khedmah — خدمة | طلب ${requestId}`,
      source: { type: this.methodToMoyasar(method) },
      metadata: {
        paymentId: payment.id,
        requestId,
        customerId,
        serviceAmount,
        materialsAmount,
        hasMaterials,
      },
    };

    try {
      const { data: moyasarResp } = await axios.post(
        `${this.moyasarBase}/payments`,
        moyasarPayload,
        { auth: { username: this.config.getOrThrow('MOYASAR_API_KEY'), password: '' } },
      );

      await this.prisma.payment.update({
        where: { id: payment.id },
        data: { moyasarRef: moyasarResp.id, metadata: moyasarResp },
      });

      return {
        paymentId: payment.id,
        moyasarId: moyasarResp.id,
        checkoutUrl: moyasarResp.source?.url,
        breakdown: {
          serviceFee: serviceAmount,
          materialsFee: materialsAmount,
          total: totalAmount,
          serviceProtected: 'محجوز في الضمان حتى إتمام الخدمة',
          materialsAvailable: hasMaterials ? 'متاح فوراً لشراء المواد المطلوبة' : null,
        },
      };
    } catch (err) {
      await this.prisma.payment.update({ where: { id: payment.id }, data: { status: 'FAILED' } });
      this.logger.error(`Payment initiation failed for request ${requestId}`, err);
      throw new BadRequestException('Payment initiation failed. Please try again.');
    }
  }

  async handleWebhook(payload: MoyasarWebhookPayload, signature: string, rawBody: Buffer) {
    const secret = this.config.getOrThrow('MOYASAR_WEBHOOK_SECRET');
    const expected = crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('hex');
    if (signature !== expected) throw new ForbiddenException('Invalid webhook signature');

    // ── Deduplication: record event before processing ──────────────────────
    // Uses upsert so a second delivery of the same event_id is a no-op.
    // The unique([provider, eventId]) constraint makes this atomic.
    const eventId = payload.id ?? payload.data?.id ?? 'unknown';
    try {
      await this.prisma.webhookEvent.create({
        data: {
          provider: 'moyasar',
          eventId,
          eventType: payload.type,
          payload: payload as unknown as import('@prisma/client').Prisma.InputJsonValue,
        },
      });
    } catch {
      // Unique constraint violation = duplicate delivery — safe to ignore
      this.logger.warn(`Duplicate Moyasar webhook ignored: ${eventId} (${payload.type})`);
      return { received: true, duplicate: true };
    }

    // Process asynchronously — return immediately so Moyasar does not retry on slow DB ops
    setImmediate(() => this._processWebhookAsync(eventId, payload).catch((err) =>
      this.logger.error(`Webhook async processing failed for ${eventId}: ${err}`),
    ));

    return { received: true };
  }

  private async _processWebhookAsync(eventId: string, payload: MoyasarWebhookPayload): Promise<void> {
    try {
      switch (payload.type) {
        case 'payment_paid':
          await this._confirmPayment(payload.data.id, payload.data);
          break;
        case 'payment_failed':
          await this._handlePaymentFailed(payload.data.id);
          break;
        case 'refund_paid':
          await this._handleRefundPaid(payload.data.id);
          break;
        default:
          this.logger.log(`Unhandled Moyasar webhook type: ${payload.type}`);
      }
    } catch (err) {
      this.logger.error(`Webhook processing error for ${eventId}: ${err}`);
      throw err;
    }
  }

  /**
   * On Moyasar webhook success:
   *   1. Atomically mark Payment as PAID AND create Escrow in one transaction
   *   2. Create MaterialsPayment record for the MATERIALS portion (if any)
   *
   * CRITICAL: The updateMany + escrow.create MUST be in the same transaction.
   * A crash between them would leave a PAID payment with no escrow, permanently
   * locking the provider's funds. With one transaction, a crash causes a rollback
   * so Moyasar's retry will re-run the full flow cleanly.
   */
  private async _confirmPayment(moyasarRef: string, _rawData?: any) {
    // Capture results outside the transaction for post-tx actions
    let confirmedPayment: Awaited<ReturnType<typeof this.prisma.payment.findUnique>> & { request: any } | null = null;
    let serviceAmt = 0;
    let materialsAmt = 0;
    let isAdjustment = false;
    let adjustmentMeta: Record<string, any> | null = null;

    await this.prisma.$transaction(async (tx) => {
      // Atomic claim: only the first webhook delivery matches status=PENDING.
      // Second delivery or retry after successful escrow creation returns count=0 → skip.
      const { count } = await tx.payment.updateMany({
        where: { moyasarRef, status: 'PENDING' },
        data: { status: 'PAID', paidAt: new Date() },
      });

      if (count === 0) {
        this.logger.warn(`_confirmPayment: payment ${moyasarRef} already processed — skipping`);
        return;
      }

      const payment = await tx.payment.findUnique({
        where: { moyasarRef },
        include: { request: true },
      });
      if (!payment) return;

      // Adjustment payments (materials top-up) must NOT create an Escrow.
      // Guard: validate adjustmentId and materialsPaymentId are present in meta to
      // prevent a crafted metadata object from bypassing escrow creation.
      const meta = payment.metadata as Record<string, any> | null;
      if (meta?.type === 'materials_adjustment') {
        if (!meta.adjustmentId || !meta.materialsPaymentId) {
          this.logger.warn(
            `Payment ${payment.id} has metadata.type=materials_adjustment but missing ` +
            `adjustmentId/materialsPaymentId — treating as normal payment`,
          );
          // Fall through to normal escrow creation
        } else {
          isAdjustment = true;
          adjustmentMeta = meta;
          confirmedPayment = payment as any;
          return; // escrow creation intentionally skipped
        }
      }

      const feePctRaw = this.config.get<string>('PLATFORM_FEE_PERCENT');
      if (!feePctRaw) this.logger.warn('PLATFORM_FEE_PERCENT not set, defaulting to 15%');
      const feePct = feePctRaw ? Number(feePctRaw) : 15;
      serviceAmt = Number(payment.serviceAmount) || Number(payment.amount);
      materialsAmt = Number(payment.materialsAmount) || 0;
      const platformFee = (serviceAmt * feePct) / 100;

      // Escrow creation is now INSIDE the same transaction as updateMany.
      // If escrow.create fails, updateMany rolls back → payment stays PENDING →
      // Moyasar retries → clean re-processing. No orphaned PAID payment possible.
      await tx.escrow.create({
        data: {
          paymentId: payment.id,
          requestId: payment.requestId,
          amount: serviceAmt,
          platformFee,
          status: 'HELD',
        },
      });

      confirmedPayment = payment as any;
    });

    // ── Post-transaction actions ─────────────────────────────────────────────
    if (!confirmedPayment) return;

    if (isAdjustment && adjustmentMeta) {
      const adjMeta = adjustmentMeta as { adjustmentId: string; materialsPaymentId: string };
      await this.materials.onAdjustmentPaymentConfirmed(
        adjMeta.adjustmentId,
        adjMeta.materialsPaymentId,
        Number((confirmedPayment as any).amount),
      );
      this.logger.log(`Adjustment payment confirmed: adjustmentId=${adjMeta.adjustmentId}`);
      return;
    }

    const payment = confirmedPayment as any;

    // Create MaterialsPayment record (depends on payment row existing, must be outside tx)
    if (materialsAmt > 0 && payment.request.hasMaterials) {
      await this.materials.create(
        payment.requestId,
        payment.id,
        Number(payment.request.materialsEstimate ?? materialsAmt),
        materialsAmt,
      );
    }

    this.events.emit('payment.confirmed', {
      paymentId: payment.id,
      requestId: payment.requestId,
      customerId: payment.request.customerId,
      amount: serviceAmt + materialsAmt,
      serviceAmount: serviceAmt,
      materialsAmount: materialsAmt,
      hasMaterials: materialsAmt > 0,
    });

    this.logger.log(
      `Payment confirmed: ${payment.id} | service=${serviceAmt} SAR | materials=${materialsAmt} SAR`,
    );
  }

  private async _handlePaymentFailed(moyasarRef: string) {
    const { count } = await this.prisma.payment.updateMany({
      where: { moyasarRef, status: 'PENDING' },
      data: { status: 'FAILED' },
    });
    if (count === 0) return; // already processed

    const payment = await this.prisma.payment.findUnique({
      where: { moyasarRef },
      include: { request: true },
    });
    if (!payment) return;

    this.events.emit('payment.failed', {
      paymentId: payment.id,
      requestId: payment.requestId,
      customerId: payment.request.customerId,
    });

    this.logger.warn(`Payment failed: moyasarRef=${moyasarRef} requestId=${payment.requestId}`);
  }

  private async _handleRefundPaid(moyasarRef: string) {
    // Moyasar confirms the refund was actually transferred back to the card.
    // Our own initiateRefund() already marked the DB as REFUNDED — this is just a confirmation log.
    const payment = await this.prisma.payment.findUnique({ where: { moyasarRef } });
    if (!payment) return;

    this.events.emit('payment.refund_confirmed', {
      paymentId: payment.id,
      requestId: payment.requestId,
    });

    this.logger.log(`Refund confirmed by Moyasar: moyasarRef=${moyasarRef}`);
  }

  async releaseEscrow(customerId: string, requestId: string) {
    const request = await this.prisma.serviceRequest.findUnique({ where: { id: requestId } });
    if (!request) throw new NotFoundException('Request not found');
    if (request.customerId !== customerId) throw new ForbiddenException('Not your request');
    if (!['IN_PROGRESS', 'COMPLETED'].includes(request.status)) {
      throw new BadRequestException('Service must be IN_PROGRESS or COMPLETED to release escrow');
    }

    const escrow = await this.prisma.escrow.findUnique({ where: { requestId } });
    if (!escrow || escrow.status !== 'HELD') throw new BadRequestException('No held escrow found');

    // Auto-reconcile materials before releasing service fee.
    // Swallow only the "already reconciled" case — propagate all other errors so
    // escrow is NOT released when the materials budget is in an inconsistent state.
    if (request.hasMaterials) {
      try {
        await this.materials.reconcile(requestId, customerId);
      } catch (err: any) {
        const msg: string = err?.message ?? '';
        const alreadyDone =
          msg.toLowerCase().includes('already reconciled') ||
          msg.toLowerCase().includes('no active materials payment');
        if (!alreadyDone) {
          this.logger.error(
            `Materials reconciliation failed for request ${requestId} before escrow release: ${msg}`,
          );
          throw err; // block escrow release until materials are resolved
        }
      }
    }

    // Use interactive transaction so the status check and completedJobs increment
    // are atomic — prevents double-increment if completeWork() runs concurrently.
    await this.prisma.$transaction(async (tx) => {
      // Re-validate inside transaction: prevents REFUNDED → RELEASED state corruption
      // if a concurrent refund races with this release.
      const { count: escrowCount } = await tx.escrow.updateMany({
        where: { requestId, status: 'HELD' },
        data: { status: 'RELEASED', releasedAt: new Date() },
      });
      if (escrowCount === 0) {
        throw new BadRequestException('Escrow is no longer in HELD state — cannot release');
      }

      // updateMany returns count=1 only if we are the one transitioning to COMPLETED.
      // If completeWork() already committed, count=0 and we skip the increment.
      const { count: transitioned } = await tx.serviceRequest.updateMany({
        where: { id: requestId, status: { not: RequestStatus.COMPLETED } },
        data: { status: 'COMPLETED', completedAt: new Date() },
      });

      if (transitioned === 0) {
        // Already COMPLETED by completeWork() — ensure completedAt is preserved
        await tx.serviceRequest.update({
          where: { id: requestId },
          data: { status: 'COMPLETED' },
        });
      } else if (request.providerId) {
        await tx.providerProfile.update({
          where: { userId: request.providerId },
          data: { completedJobs: { increment: 1 } },
        });
      }
    });

    this.events.emit('escrow.released', { requestId, providerId: request.providerId });
    return { message: 'خدمة مكتملة — تم الإفراج عن المبلغ للمزود' };
  }

  async getPaymentStatus(customerId: string, paymentId: string) {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      include: { request: true, escrow: true, materialsPayment: true },
    });
    if (!payment) throw new NotFoundException('Payment not found');
    if (payment.request.customerId !== customerId) throw new ForbiddenException('Not your payment');

    return {
      ...payment,
      breakdown: {
        serviceFee: Number(payment.serviceAmount),
        materialsFee: Number(payment.materialsAmount),
        total: Number(payment.amount),
      },
    };
  }

  async initiateRefund(adminId: string, paymentId: string, reason: string, partialAmount?: number, skipStatusUpdate?: boolean) {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      include: { escrow: true, request: true },
    });
    if (!payment) throw new NotFoundException('Payment not found');
    if (payment.status !== 'PAID')
      throw new BadRequestException('Only PAID payments can be refunded');
    if (!payment.moyasarRef) throw new BadRequestException('No Moyasar reference on this payment');

    try {
      await axios.post(
        `${this.moyasarBase}/payments/${payment.moyasarRef}/refund`,
        { amount: partialAmount ? Math.round(partialAmount * 100) : Math.round(Number(payment.amount) * 100) },
        { auth: { username: this.config.getOrThrow('MOYASAR_API_KEY'), password: '' } },
      );
    } catch (err: any) {
      const detail = err?.response?.data ?? err?.message ?? String(err);
      this.logger.error(`Moyasar refund failed for payment ${paymentId} (ref ${payment.moyasarRef}): ${JSON.stringify(detail)}`);
      this.events.emit('payment.refund_failed', { paymentId, adminId, reason, detail });
      throw new BadRequestException('Refund request to Moyasar failed');
    }

    // Refund both escrow and materials if applicable
    if (payment.request.hasMaterials) {
      try {
        await this.materials.fullRefund(payment.requestId);
      } catch {
        // Materials already used — requires manual reconciliation
      }
    }

    await this.prisma.$transaction([
      this.prisma.payment.update({
        where: { id: paymentId },
        data: { status: 'REFUNDED' },
      }),
      ...(payment.escrow
        ? [
            this.prisma.escrow.update({
              where: { id: payment.escrow.id },
              data: { status: 'REFUNDED', releasedAt: new Date() },
            }),
          ]
        : []),
      ...(skipStatusUpdate
        ? []
        : [
            this.prisma.serviceRequest.update({
              where: { id: payment.requestId },
              data: { status: 'CANCELLED' },
            }),
          ]),
    ]);

    this.events.emit('payment.refunded', { paymentId, adminId, reason });
    return { message: 'تم رد المبلغ بنجاح' };
  }

  async getEscrowStatus(requestId: string, userId: string) {
    const request = await this.prisma.serviceRequest.findUnique({
      where: { id: requestId },
      select: { customerId: true, providerId: true },
    });
    if (!request || (request.customerId !== userId && request.providerId !== userId)) {
      throw new ForbiddenException('Access denied');
    }

    const [escrow, mp] = await Promise.all([
      this.prisma.escrow.findUnique({ where: { requestId } }),
      this.prisma.materialsPayment.findUnique({ where: { requestId } }),
    ]);

    return {
      escrow,
      materialsPayment: mp ?? null,
      hasMaterials: !!mp,
      summary: escrow
        ? {
            serviceHeld: Number(escrow.amount),
            materialsAvailable: mp ? Number(mp.paidAmount) - Number(mp.usedAmount) : 0,
            materialsUsed: mp ? Number(mp.usedAmount) : 0,
          }
        : null,
    };
  }

  // ── Materials adjustment payment (pass-through to MaterialsPaymentService) ─
  async initiateMaterialsAdjustmentPayment(
    customerId: string,
    adjustmentId: string,
    method: string,
  ) {
    return this.materials.payForAdjustment(customerId, adjustmentId, method);
  }

  private methodToMoyasar(method: string): string {
    const map: Record<string, string> = {
      MADA: 'creditcard',
      CREDIT_CARD: 'creditcard',
      STC_PAY: 'stcpay',
      APPLE_PAY: 'applepay',
    };
    return map[method] || 'creditcard';
  }
}
