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
import { QuoteStatus } from '@prisma/client';
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

    const existing = await this.prisma.payment.findFirst({
      where: { requestId, status: { in: ['PENDING', 'PAID'] } },
    });
    if (existing) {
      throw new ConflictException('Payment already initiated for this request');
    }

    const serviceAmount = Number(quote.amount);
    const materialsAmount = hasMaterials ? materialsEstimate : 0;
    const totalAmount = serviceAmount + materialsAmount;

    // Persist split amounts before Moyasar call so the webhook can reference them
    const payment = await this.prisma.payment.create({
      data: {
        requestId,
        amount: totalAmount,
        serviceAmount,
        materialsAmount,
        method: method as any,
        status: 'PENDING',
      },
    });

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

    return { received: true };
  }

  /**
   * On Moyasar webhook success:
   *   1. Atomically mark Payment as PAID (updateMany with status=PENDING guard)
   *   2. Create Escrow for the SERVICE portion only
   *   3. Create MaterialsPayment record for the MATERIALS portion (if any)
   *
   * The atomic updateMany prevents duplicate processing when Moyasar retries
   * the webhook — only the first delivery will match status=PENDING and proceed.
   */
  private async _confirmPayment(moyasarRef: string, _rawData?: any) {
    // Atomic claim: only succeeds for the one delivery where status is still PENDING
    const { count } = await this.prisma.payment.updateMany({
      where: { moyasarRef, status: 'PENDING' },
      data: { status: 'PAID', paidAt: new Date() },
    });
    if (count === 0) {
      this.logger.warn(`_confirmPayment: payment ${moyasarRef} already processed — skipping`);
      return;
    }

    const payment = await this.prisma.payment.findUnique({
      where: { moyasarRef },
      include: { request: true },
    });
    if (!payment) return;

    // Check for materials_adjustment FIRST — before creating any Escrow.
    // Adjustment payments must never create an Escrow row (the Escrow for this
    // requestId already exists from the original payment). Creating one here
    // would leave an orphan row and crash on the second adjustment due to the
    // @unique constraint on Escrow.requestId.
    const meta = payment.metadata as Record<string, any> | null;
    if (meta?.type === 'materials_adjustment') {
      await this.materials.onAdjustmentPaymentConfirmed(
        meta.adjustmentId,
        meta.materialsPaymentId,
        Number(payment.amount),
      );
      this.logger.log(`Adjustment payment confirmed: adjustmentId=${meta.adjustmentId}`);
      return;
    }

    const feePctRaw = this.config.get<string>('PLATFORM_FEE_PERCENT');
    if (!feePctRaw) {
      this.logger.warn('PLATFORM_FEE_PERCENT not set, defaulting to 15%');
    }
    const feePct = feePctRaw ? Number(feePctRaw) : 15;
    const serviceAmt = Number(payment.serviceAmount) || Number(payment.amount);
    const materialsAmt = Number(payment.materialsAmount) || 0;
    const platformFee = (serviceAmt * feePct) / 100;

    // Payment row is already marked PAID by the atomic updateMany above.
    // Only create escrow here (inside a transaction for atomicity).
    await this.prisma.$transaction([
      // Create escrow for SERVICE portion only
      this.prisma.escrow.create({
        data: {
          paymentId: payment.id,
          requestId: payment.requestId,
          amount: serviceAmt,
          platformFee,
          status: 'HELD',
        },
      }),
      // Request stays ACCEPTED — provider explicitly calls startWork() → IN_PROGRESS
    ]);

    // Create MaterialsPayment record outside transaction (depends on payment row)
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

    // Auto-reconcile materials before releasing service fee
    if (request.hasMaterials) {
      try {
        await this.materials.reconcile(requestId, customerId);
      } catch {
        // Already reconciled — that's fine
      }
    }

    // Use interactive transaction so the status check and completedJobs increment
    // are atomic — prevents double-increment if completeWork() runs concurrently.
    await this.prisma.$transaction(async (tx) => {
      await tx.escrow.update({
        where: { requestId },
        data: { status: 'RELEASED', releasedAt: new Date() },
      });

      // updateMany returns count=1 only if we are the one transitioning to COMPLETED.
      // If completeWork() already committed, count=0 and we skip the increment.
      const { count: transitioned } = await tx.serviceRequest.updateMany({
        where: { id: requestId, status: { not: 'COMPLETED' as any } },
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
    } catch {
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
