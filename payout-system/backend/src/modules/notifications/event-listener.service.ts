import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { NotificationsService } from './notifications.service';

@Injectable()
export class NotificationEventListener {
  private readonly logger = new Logger(NotificationEventListener.name);

  constructor(private readonly notifications: NotificationsService) {}

  /**
   * Notify customer when payment is confirmed.
   */
  @OnEvent('payment.confirmed')
  async handlePaymentConfirmed(payload: {
    orderId: string;
    customerId: string;
    amount: number;
  }) {
    try {
      await this.notifications.notify(
        payload.customerId,
        'تم استلام دفعتك',
        `تم تأكيد دفعتك بقيمة ${payload.amount.toFixed(2)} ريال بنجاح. سيتم تعيين مزود خدمة قريباً.`,
        'payment.confirmed',
        { orderId: payload.orderId, amount: payload.amount },
      );
    } catch (error) {
      this.logger.error(`Failed to notify payment.confirmed: ${error.message}`);
    }
  }

  /**
   * Notify customer when a provider accepts their order.
   */
  @OnEvent('order.accepted')
  async handleOrderAccepted(payload: {
    orderId: string;
    customerId: string;
    providerId: string;
  }) {
    try {
      await this.notifications.notify(
        payload.customerId,
        'قبل مزودك طلبك',
        'قام مزود الخدمة بقبول طلبك وسيبدأ العمل قريباً.',
        'order.accepted',
        { orderId: payload.orderId, providerId: payload.providerId },
      );
    } catch (error) {
      this.logger.error(`Failed to notify order.accepted: ${error.message}`);
    }
  }

  /**
   * Notify customer when provider marks work complete.
   */
  @OnEvent('order.completed')
  async handleOrderCompleted(payload: {
    orderId: string;
    customerId: string;
    providerId: string;
  }) {
    try {
      await this.notifications.notify(
        payload.customerId,
        'اكتمل العمل — يرجى تأكيد الإفراج',
        'أبلغ المزود باكتمال العمل. يرجى مراجعة العمل والضغط على "تأكيد الاستلام" لتحرير المبلغ للمزود، أو سيتم الإفراج تلقائياً خلال 48 ساعة.',
        'order.completed',
        { orderId: payload.orderId },
      );
    } catch (error) {
      this.logger.error(`Failed to notify order.completed: ${error.message}`);
    }
  }

  /**
   * Notify provider when escrow is released.
   */
  @OnEvent('escrow.released')
  async handleEscrowReleased(payload: {
    escrowId: string;
    orderId: string;
    providerUserId: string;
    amount: number;
  }) {
    try {
      if (!payload.providerUserId) {
        this.logger.warn(`escrow.released event missing providerUserId for escrow=${payload.escrowId}`);
        return;
      }

      await this.notifications.notify(
        payload.providerUserId,
        'تم الإفراج عن مبلغك',
        `تم الإفراج عن مبلغ ${payload.amount.toFixed(2)} ريال في محفظتك. يمكنك الآن طلب سحبه إلى حسابك البنكي.`,
        'escrow.released',
        { escrowId: payload.escrowId, orderId: payload.orderId, amount: payload.amount },
      );
    } catch (error) {
      this.logger.error(`Failed to notify escrow.released: ${error.message}`);
    }
  }

  /**
   * Notify provider when payout is completed (money transferred to bank).
   */
  @OnEvent('payout.completed')
  async handlePayoutCompleted(payload: {
    payoutId: string;
    providerUserId: string;
    amount: number;
    gatewayRef: string;
  }) {
    try {
      await this.notifications.notify(
        payload.providerUserId,
        'تم تحويل مبلغك إلى حسابك البنكي',
        `تم تحويل مبلغ ${payload.amount.toFixed(2)} ريال إلى حسابك البنكي بنجاح. رقم المرجع: ${payload.gatewayRef}`,
        'payout.completed',
        { payoutId: payload.payoutId, amount: payload.amount, gatewayRef: payload.gatewayRef },
      );
    } catch (error) {
      this.logger.error(`Failed to notify payout.completed: ${error.message}`);
    }
  }

  /**
   * Notify provider when payout fails.
   */
  @OnEvent('payout.failed')
  async handlePayoutFailed(payload: {
    payoutId: string;
    providerUserId: string;
    amount: number;
    reason: string;
  }) {
    try {
      await this.notifications.notify(
        payload.providerUserId,
        'فشل تحويل المبلغ — تواصل مع الدعم',
        `تعذر تحويل مبلغ ${payload.amount.toFixed(2)} ريال إلى حسابك البنكي. السبب: ${payload.reason}. يرجى التواصل مع فريق الدعم.`,
        'payout.failed',
        { payoutId: payload.payoutId, amount: payload.amount, reason: payload.reason },
      );
    } catch (error) {
      this.logger.error(`Failed to notify payout.failed: ${error.message}`);
    }
  }

  /**
   * Notify provider when their escrow is refunded (order cancelled).
   */
  @OnEvent('escrow.refunded')
  async handleEscrowRefunded(payload: {
    escrowId: string;
    orderId: string;
    amount: number;
  }) {
    this.logger.log(
      `Escrow refunded: escrowId=${payload.escrowId} orderId=${payload.orderId} amount=${payload.amount}`,
    );
    // Customer refund notification would be triggered here if customerId is provided
  }
}
