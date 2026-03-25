import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { MoyasarService, MoyasarSource } from './moyasar.service';
import { EscrowService } from '../escrow/escrow.service';
import { LedgerService } from '../ledger/ledger.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import { PaymentStatus, LedgerType } from '@prisma/client';
import * as crypto from 'crypto';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly moyasar: MoyasarService,
    private readonly escrowService: EscrowService,
    private readonly ledger: LedgerService,
    private readonly eventEmitter: EventEmitter2,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Initiate a payment for an order.
   * Creates a Transaction record then calls Moyasar.
   */
  async createPaymentRequest(
    orderId: string,
    customerId: string,
    source: MoyasarSource,
  ) {
    // Validate order
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { commissionBreakdown: true, transaction: true },
    });

    if (!order) throw new NotFoundException(`Order ${orderId} not found`);
    if (order.customerId !== customerId) {
      throw new BadRequestException('This order does not belong to you');
    }
    if (order.status !== 'CREATED') {
      throw new BadRequestException(
        `Order must be in CREATED status to initiate payment (current: ${order.status})`,
      );
    }

    // Idempotency — return existing pending transaction
    if (order.transaction && order.transaction.status === PaymentStatus.PENDING) {
      return {
        transaction: order.transaction,
        message: 'Existing pending payment found',
      };
    }

    if (order.transaction && order.transaction.status === PaymentStatus.PAID) {
      throw new ConflictException('Order is already paid');
    }

    const idempotencyKey = crypto.randomUUID();
    const amount = Number(order.totalAmount);

    // Create transaction record first
    const transaction = await this.prisma.transaction.create({
      data: {
        orderId,
        idempotencyKey,
        amount,
        currency: 'SAR',
        status: PaymentStatus.PENDING,
      },
    });

    // Call Moyasar
    const appUrl = this.configService.get<string>('APP_URL', 'http://localhost:3000');
    let gatewayResponse: any = null;

    try {
      const moyasarPayment = await this.moyasar.createPayment({
        amount,
        currency: 'SAR',
        description: `طلب خدمة: ${order.serviceTitle}`,
        source,
        callbackUrl: `${appUrl}/api/v1/payments/webhook`,
        metadata: {
          orderId,
          transactionId: transaction.id,
          customerId,
        },
      });

      gatewayResponse = moyasarPayment;

      await this.prisma.transaction.update({
        where: { id: transaction.id },
        data: {
          gatewayReference: moyasarPayment.id,
          gatewayResponse: moyasarPayment as any,
        },
      });

      this.logger.log(`Payment initiated: order=${orderId} moyasar=${moyasarPayment.id}`);

      return {
        transaction: {
          ...transaction,
          gatewayReference: moyasarPayment.id,
        },
        gatewayResponse: moyasarPayment,
      };
    } catch (error) {
      // Mark transaction as failed on gateway error
      await this.prisma.transaction.update({
        where: { id: transaction.id },
        data: {
          status: PaymentStatus.FAILED,
          gatewayResponse: { error: error.message },
        },
      });
      throw error;
    }
  }

  /**
   * Handle Moyasar webhook.
   * Verifies HMAC-SHA256 signature, processes payment confirmation.
   */
  async handleWebhook(payload: any, signature: string): Promise<void> {
    // Verify signature
    const webhookSecret = this.configService.get<string>('MOYASAR_WEBHOOK_SECRET');
    const computedSig = crypto
      .createHmac('sha256', webhookSecret)
      .update(JSON.stringify(payload))
      .digest('hex');

    if (computedSig !== signature) {
      this.logger.warn('Webhook signature mismatch — rejecting');
      throw new BadRequestException('Invalid webhook signature');
    }

    const moyasarPaymentId = payload.id;
    const status = payload.status;

    if (status !== 'paid') {
      this.logger.log(`Webhook received non-paid status: ${status} for ${moyasarPaymentId}`);
      return;
    }

    // Find transaction
    const transaction = await this.prisma.transaction.findUnique({
      where: { gatewayReference: moyasarPaymentId },
      include: {
        order: { include: { commissionBreakdown: true } },
      },
    });

    if (!transaction) {
      this.logger.warn(`Webhook: no transaction found for gateway ref ${moyasarPaymentId}`);
      return;
    }

    // Idempotency — skip if already processed
    if (transaction.status === PaymentStatus.PAID) {
      this.logger.warn(`Webhook: payment ${moyasarPaymentId} already processed — skipping`);
      return;
    }

    const providerAmount = transaction.order.commissionBreakdown
      ? Number(transaction.order.commissionBreakdown.providerAmount)
      : Number(transaction.amount) * 0.825; // fallback: 85% - 15% VAT

    // Atomic: mark paid + create escrow
    await this.prisma.$transaction(async (tx) => {
      await tx.transaction.update({
        where: { id: transaction.id },
        data: {
          status: PaymentStatus.PAID,
          paidAt: new Date(),
          gatewayResponse: payload,
        },
      });
    });

    // Create escrow for provider's share
    await this.escrowService.create(transaction.orderId, providerAmount);

    // Record payment in ledger
    await this.ledger.record(
      LedgerType.PAYMENT_RECEIVED,
      moyasarPaymentId,
      Number(transaction.amount),
      transaction.orderId,
      `Payment received for order ${transaction.orderId}`,
      { moyasarPaymentId },
    );

    await this.ledger.record(
      LedgerType.COMMISSION_DEDUCTED,
      transaction.id,
      Number(transaction.amount) - providerAmount,
      transaction.orderId,
      'Platform commission deducted',
    );

    await this.ledger.record(
      LedgerType.PROVIDER_ALLOCATION,
      transaction.id,
      providerAmount,
      transaction.orderId,
      'Provider amount allocated to escrow',
    );

    this.eventEmitter.emit('payment.confirmed', {
      orderId: transaction.orderId,
      customerId: transaction.order.customerId,
      transactionId: transaction.id,
      amount: Number(transaction.amount),
    });

    this.logger.log(
      `Payment confirmed: order=${transaction.orderId} amount=${transaction.amount}`,
    );
  }

  /**
   * Get payment/transaction status for an order.
   */
  async getStatus(orderId: string) {
    const transaction = await this.prisma.transaction.findUnique({
      where: { orderId },
      include: { order: { select: { status: true, serviceTitle: true, customerId: true } } },
    });

    if (!transaction) {
      throw new NotFoundException(`No transaction found for order ${orderId}`);
    }

    return transaction;
  }

  /**
   * Process a refund when order is cancelled post-payment.
   */
  async refundOrder(orderId: string): Promise<void> {
    const transaction = await this.prisma.transaction.findUnique({
      where: { orderId },
    });

    if (!transaction) {
      throw new NotFoundException(`No transaction for order ${orderId}`);
    }

    if (transaction.status !== PaymentStatus.PAID) {
      throw new BadRequestException('Cannot refund — payment is not in PAID status');
    }

    if (!transaction.gatewayReference) {
      throw new BadRequestException('No gateway reference to refund');
    }

    await this.moyasar.refundPayment(
      transaction.gatewayReference,
      Number(transaction.amount),
    );

    await this.prisma.transaction.update({
      where: { id: transaction.id },
      data: { status: PaymentStatus.REFUNDED },
    });

    await this.ledger.record(
      LedgerType.REFUND_ISSUED,
      transaction.id,
      Number(transaction.amount),
      orderId,
      `Full refund issued for order ${orderId}`,
    );

    this.logger.log(`Refund completed: order=${orderId} amount=${transaction.amount}`);
  }
}
