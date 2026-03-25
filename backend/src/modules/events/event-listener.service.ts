import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { WalletService } from '../wallet/wallet.service';
import { WalletCreditProducer } from '../wallet/wallet-credit.queue';
import { PaymentsService } from '../payments/payments.service';
import { Decimal } from '@prisma/client/runtime/library';
import { WalletTxType } from '@prisma/client';

/**
 * Central event listener — handles cross-cutting notifications and
 * side-effects that don't belong in any single domain service.
 *
 * NOTE: Domain-specific events (provider approved, quote accepted, etc.)
 * are already handled directly in NotificationsService to keep this file
 * focused on events that need DB lookups beyond what the emitter provides.
 */
@Injectable()
export class EventListenerService {
  private readonly logger = new Logger(EventListenerService.name);

  constructor(
    private prisma: PrismaService,
    private notif: NotificationsService,
    private wallet: WalletService,
    private walletCreditProducer: WalletCreditProducer,
    private payments: PaymentsService,
    private readonly config: ConfigService,
  ) {}

  // ── Escrow events ────────────────────────────────────────────────────────

  /**
   * When escrow is released (by customer, auto-scheduler, or admin dispute resolution),
   * credit the provider's wallet with their net payout (amount − platformFee).
   */
  @OnEvent('escrow.released')
  async onEscrowReleased(event: { requestId: string; providerId?: string; escrowId?: string }) {
    try {
      // Fetch escrow by requestId to get the definitive amounts
      const escrow = await this.prisma.escrow.findUnique({
        where: { requestId: event.requestId },
        select: {
          id: true,
          amount: true,
          platformFee: true,
          requestId: true,
          request: { select: { providerId: true } },
        },
      });
      if (!escrow) {
        this.logger.warn(`escrow.released: no escrow found for request ${event.requestId}`);
        return;
      }

      const providerId = event.providerId ?? escrow.request.providerId;
      if (!providerId) {
        this.logger.warn(`escrow.released: no providerId for request ${event.requestId}`);
        return;
      }

      const netPayout = Number(escrow.amount) - Number(escrow.platformFee);
      if (netPayout <= 0) return;

      await this.walletCreditProducer.enqueueCredit({
        userId: providerId,
        amount: netPayout,
        type: 'ESCROW_RELEASE',
        referenceId: escrow.id,
        refType: 'escrow',
        description: 'مستحقات خدمة — إطلاق الضمان',
        idempotencyKey: `escrow-release-${escrow.id}`,
      });

      this.logger.log(
        `Wallet credit enqueued: provider ${providerId} +${netPayout} SAR (escrow ${escrow.id})`,
      );
    } catch (err) {
      this.logger.error(`onEscrowReleased failed for request ${event.requestId}: ${err}`);
    }
  }

  @OnEvent('escrow.refund_on_cancel')
  async onEscrowRefundOnCancel(payload: { escrowId: string; requestId: string; customerId: string; amount: any }) {
    try {
      await this.walletCreditProducer.enqueueCredit({
        userId: payload.customerId,
        amount: Number(payload.amount),
        type: 'REFUND',
        referenceId: payload.escrowId,
        refType: 'refund',
        description: `استرداد مبلغ الطلب ${payload.requestId}`,
        idempotencyKey: `escrow-refund-cancel-${payload.escrowId}`,
      });
      await this.notif.notifyUser(
        payload.customerId,
        'تم استرداد المبلغ',
        'تم استرجاع مبلغ طلبك الملغى إلى محفظتك',
        { requestId: payload.requestId },
      );
    } catch (err) {
      this.logger.error(`onEscrowRefundOnCancel failed: ${err}`);
    }
  }

  // ── Tender events ───────────────────────────────────────────────────────

  @OnEvent('commissions.overdue_batch')
  async onCommissionsOverdue(payload: { count: number }) {
    this.logger.warn(`${payload.count} commissions marked overdue`);
    const adminEmail = this.config.get<string>('ADMIN_EMAIL', '');
    if (adminEmail) {
      await this.notif.sendEmail(
        adminEmail,
        `⚠️ ${payload.count} عمولات متأخرة — منصة خدمة`,
        `<p>يوجد <strong>${payload.count}</strong> عمولة مناقصة متأخرة تحتاج متابعة.</p>`,
      );
    }
  }

  // ── Support ticket events ───────────────────────────────────────────────

  @OnEvent('support.ticket_opened')
  async onTicketOpened(payload: {
    ticketId: string;
    userId: string;
    category: string;
    priority: string;
  }) {
    // Notify admin for URGENT tickets
    if (payload.priority === 'URGENT') {
      const adminEmail = this.config.get<string>('ADMIN_EMAIL', '');
      if (adminEmail) {
        await this.notif.sendEmail(
          adminEmail,
          `🚨 تذكرة دعم عاجلة — ${payload.ticketId.slice(0, 8).toUpperCase()}`,
          `<p>فُتحت تذكرة دعم <strong>عاجلة</strong> بتصنيف <strong>${payload.category}</strong>.<br>معرف التذكرة: ${payload.ticketId}</p>`,
        );
      }
    }
  }

  // ── Dispute events ──────────────────────────────────────────────────────

  @OnEvent('dispute.refund_ordered')
  async onDisputeRefundOrdered(payload: {
    disputeId: string;
    requestId: string;
    paymentId: string;
    adminId: string;
  }) {
    try {
      if (!payload.paymentId) {
        this.logger.warn(`dispute.refund_ordered: no paymentId for request ${payload.requestId}`);
        return;
      }
      await this.payments.initiateRefund(
        payload.adminId,
        payload.paymentId,
        `حل نزاع — معرف النزاع: ${payload.disputeId}`,
      );
      this.logger.log(`Refund initiated for dispute ${payload.disputeId}, payment ${payload.paymentId}`);
    } catch (err) {
      this.logger.error(`onDisputeRefundOrdered failed for dispute ${payload.disputeId}: ${err}`);
    }
  }

  @OnEvent('dispute.split_release')
  async onDisputeSplitRelease(payload: {
    requestId: string;
    providerId?: string;
    providerAmount: number;
    escrowId: string;
  }) {
    try {
      if (!payload.providerId || payload.providerAmount <= 0) return;
      await this.walletCreditProducer.enqueueCredit({
        userId: payload.providerId,
        amount: payload.providerAmount,
        type: 'DISPUTE_SPLIT',
        referenceId: payload.escrowId,
        refType: 'escrow',
        description: 'حل نزاع — نصف مستحقات الخدمة',
        idempotencyKey: `dispute-split-release-${payload.escrowId}`,
      });
      this.logger.log(`Split release enqueued: provider ${payload.providerId} +${payload.providerAmount} SAR`);
    } catch (err) {
      this.logger.error(`onDisputeSplitRelease failed for request ${payload.requestId}: ${err}`);
    }
  }

  @OnEvent('dispute.split_refund')
  async onDisputeSplitRefund(payload: {
    disputeId: string;
    requestId: string;
    paymentId: string;
    refundAmount: number;
    adminId: string;
  }) {
    try {
      if (!payload.paymentId) return;
      await this.payments.initiateRefund(
        payload.adminId,
        payload.paymentId,
        `حل نزاع (تقسيم) — استرداد نصف المبلغ | نزاع: ${payload.disputeId}`,
        payload.refundAmount,
        true, // skipStatusUpdate: request is COMPLETED from SPLIT resolution, not CANCELLED
      );
      this.logger.log(`Split refund initiated for dispute ${payload.disputeId}, amount ${payload.refundAmount} SAR`);
    } catch (err) {
      this.logger.error(`onDisputeSplitRefund failed for dispute ${payload.disputeId}: ${err}`);
    }
  }

  @OnEvent('dispute.opened')
  async onDisputeOpened(payload: {
    disputeId: string;
    requestId: string;
    reporterId: string;
    againstId: string;
  }) {
    await this.notif.notifyUser(
      payload.againstId,
      '⚠️ نزاع جديد',
      'فُتح نزاع ضدك. سيراجعه فريق الدعم خلال 24 ساعة.',
      { disputeId: payload.disputeId, requestId: payload.requestId },
    );
    this.logger.log(`Dispute opened: ${payload.disputeId}`);
  }

  // ── Materials payment events ─────────────────────────────────────────────

  @OnEvent('materials.payment.funded')
  async onMaterialsFunded(payload: { requestId: string; amount: number }) {
    const request = await this.prisma.serviceRequest.findUnique({
      where: { id: payload.requestId },
      select: { providerId: true },
    });
    if (request?.providerId) {
      await this.notif.notifyUser(
        request.providerId,
        '💰 ميزانية المواد متاحة',
        `تم تمويل ميزانية المواد (${payload.amount} ريال). يمكنك الآن إدارة المشتريات.`,
        { requestId: payload.requestId },
      );
    }
  }

  @OnEvent('materials.adjustment.requested')
  async onAdjustmentRequested(payload: {
    requestId: string;
    providerId: string;
    amount: number;
    adjustmentId: string;
    expiresAt: Date;
  }) {
    const request = await this.prisma.serviceRequest.findUnique({
      where: { id: payload.requestId },
      select: { customerId: true },
    });
    if (request?.customerId) {
      await this.notif.notifyUser(
        request.customerId,
        '🔔 طلب زيادة ميزانية المواد',
        `يطلب المزود إضافة ${payload.amount} ريال لميزانية المواد. يرجى الموافقة أو الرفض.`,
        { requestId: payload.requestId, adjustmentId: payload.adjustmentId },
      );
    }
  }

  @OnEvent('materials.adjustment.responded')
  async onAdjustmentResponded(payload: {
    adjustmentId: string;
    approved: boolean;
    requestId: string;
  }) {
    const adj = await this.prisma.materialsAdjustmentRequest.findUnique({
      where: { id: payload.adjustmentId },
      include: { materialsPayment: { include: { request: { select: { providerId: true } } } } },
    });
    const providerId = adj?.materialsPayment?.request?.providerId;
    if (providerId) {
      const titleAr = payload.approved ? '✅ تمت الموافقة على طلب الزيادة' : '❌ رُفض طلب الزيادة';
      const bodyAr = payload.approved
        ? 'وافق العميل على زيادة ميزانية المواد. الرصيد الإضافي متاح الآن.'
        : 'رفض العميل طلب زيادة ميزانية المواد.';
      await this.notif.notifyUser(providerId, titleAr, bodyAr, { requestId: payload.requestId });
    }
  }

  @OnEvent('materials.usage.rejected')
  async onUsageRejected(payload: { usageLogId: string; amount: number }) {
    const log = await this.prisma.materialsUsageLog.findUnique({
      where: { id: payload.usageLogId },
      select: { loggedById: true },
    });
    if (log?.loggedById) {
      await this.notif.notifyUser(
        log.loggedById,
        '❌ رُفض إدخال المواد',
        `رفض المشرف إدخال مبلغ ${payload.amount} ريال. تم إعادة المبلغ للرصيد.`,
        { usageLogId: payload.usageLogId },
      );
    }
  }

  @OnEvent('materials.reconciled.refund')
  async onMaterialsRefundPartial(payload: { requestId: string; refundAmount: number }) {
    const request = await this.prisma.serviceRequest.findUnique({
      where: { id: payload.requestId },
      select: { customerId: true },
    });
    if (request?.customerId) {
      await this.notif.notifyUser(
        request.customerId,
        '💸 استرداد جزء من ميزانية المواد',
        `تم استرداد ${payload.refundAmount} ريال (الرصيد غير المستخدم من ميزانية المواد).`,
        { requestId: payload.requestId },
      );
    }
  }

  @OnEvent('materials.refund.full')
  async onMaterialsRefundFull(payload: { requestId: string; amount: number }) {
    const request = await this.prisma.serviceRequest.findUnique({
      where: { id: payload.requestId },
      select: { customerId: true },
    });
    if (request?.customerId) {
      await this.notif.notifyUser(
        request.customerId,
        '💸 استرداد كامل ميزانية المواد',
        `تم استرداد ${payload.amount} ريال كاملة من ميزانية المواد.`,
        { requestId: payload.requestId },
      );
    }
  }

  // ── Equipment events ─────────────────────────────────────────────────────

  @OnEvent('equipment.rental.status_changed')
  async onRentalStatusChanged(payload: { id: string; status: string }) {
    const rental = await this.prisma.equipmentRental.findUnique({
      where: { id: payload.id },
      select: { renterId: true, equipment: { select: { name: true } } },
    });
    if (!rental) return;

    const statusMessages: Record<string, string> = {
      CONFIRMED: 'تم تأكيد طلب الإيجار. المعدة محجوزة لك.',
      ACTIVE: 'بدأ إيجار معدتك.',
      COMPLETED: 'اكتمل الإيجار بنجاح.',
      CANCELLED: 'تم إلغاء طلب الإيجار.',
    };
    const bodyAr = statusMessages[payload.status];
    if (bodyAr) {
      await this.notif.notifyUser(
        rental.renterId,
        `تحديث حالة إيجار: ${rental.equipment.name}`,
        bodyAr,
        { rentalId: payload.id },
      );
    }
  }

  @OnEvent('equipment.inquiry_received')
  async onEquipmentInquiry(payload: { equipmentId: string; ownerId: string; inquiryId: string }) {
    const equipment = await this.prisma.equipment.findUnique({
      where: { id: payload.equipmentId },
      select: { name: true },
    });
    if (equipment) {
      await this.notif.notifyUser(
        payload.ownerId,
        '📩 استفسار جديد عن معدتك',
        `تلقيت استفساراً جديداً عن "${equipment.name}". راجع تفاصيل الاستفسار للرد.`,
        { equipmentId: payload.equipmentId, inquiryId: payload.inquiryId },
      );
    }
  }

  @OnEvent('equipment.reviewed')
  async onEquipmentReviewed(payload: { rentalId: string; score: number }) {
    const rental = await this.prisma.equipmentRental.findUnique({
      where: { id: payload.rentalId },
      include: { equipment: { select: { ownerId: true, name: true } } },
    });
    if (rental?.equipment?.ownerId) {
      await this.notif.notifyUser(
        rental.equipment.ownerId,
        '⭐ تقييم جديد لمعدتك',
        `حصلت معدة "${rental.equipment.name}" على تقييم ${payload.score}/5.`,
        { rentalId: payload.rentalId },
      );
    }
  }

  @OnEvent('equipment.rental.completed')
  async onEquipmentRentalCompleted(payload: {
    rentalId: string;
    equipmentId: string;
    ownerId: string;
    renterId: string;
    totalPrice: number;
    platformFee: number;
  }) {
    try {
      const ownerPayout = payload.totalPrice - payload.platformFee;
      await this.walletCreditProducer.enqueueCredit({
        userId: payload.ownerId,
        amount: ownerPayout,
        type: 'RENTAL_COMPLETE',
        referenceId: payload.rentalId,
        refType: 'equipment_rental',
        description: 'إيرادات تأجير معدة',
        idempotencyKey: `equipment-rental-complete-${payload.rentalId}`,
      });
      this.logger.log(
        `Equipment rental credit enqueued: owner ${payload.ownerId} +${ownerPayout} SAR (rental ${payload.rentalId})`,
      );
    } catch (err) {
      this.logger.error(`onEquipmentRentalCompleted failed: ${err}`);
    }
  }

  // ── Consultation events ──────────────────────────────────────────────────

  @OnEvent('consultation.charge_required')
  async onConsultationChargeRequired(payload: {
    consultationId: string;
    customerId: string;
    providerId: string;
    amount: number;
  }) {
    const CONSULTATION_FEE_RATE = 0.15;
    const platformFee = parseFloat((payload.amount * CONSULTATION_FEE_RATE).toFixed(2));
    const providerNet = parseFloat((payload.amount - platformFee).toFixed(2));

    const debitKey = `consultation-debit-${payload.consultationId}`;
    const creditKey = `consultation-credit-${payload.consultationId}`;

    try {
      // Idempotency guard: if the debit transaction already exists this event has
      // already been processed (e.g. duplicate event emission or handler retry).
      const alreadyCharged = await this.prisma.walletTransaction.findFirst({
        where: { idempotencyKey: debitKey },
      });
      if (alreadyCharged) {
        this.logger.log(`Consultation charge already processed, skipping: ${payload.consultationId}`);
        return;
      }

      // Ensure both wallets exist before entering the transaction (idempotent).
      // getOrCreate is safe outside the tx — it uses upsert internally.
      await Promise.all([
        this.wallet.getOrCreate(payload.customerId),
        this.wallet.getOrCreate(payload.providerId),
      ]);

      // Use an interactive transaction so the balance check and the debits/credits
      // happen atomically. This eliminates the TOCTOU race where two concurrent
      // charge events both pass the balance check before either write commits.
      await this.prisma.$transaction(async (tx) => {
        // Re-fetch inside the transaction to get a consistent snapshot.
        const customerWallet = await tx.wallet.findUnique({
          where: { userId: payload.customerId },
        });
        if (!customerWallet) throw new Error(`Customer wallet not found: ${payload.customerId}`);

        const customerAvailable = new Decimal(customerWallet.balance).minus(customerWallet.heldBalance);
        if (customerAvailable.lessThan(payload.amount)) {
          throw new Error(
            `Insufficient balance: customer ${payload.customerId} has ${customerAvailable} but needs ${payload.amount}`,
          );
        }

        const providerWallet = await tx.wallet.findUnique({
          where: { userId: payload.providerId },
        });
        if (!providerWallet) throw new Error(`Provider wallet not found: ${payload.providerId}`);

        const customerNewBalance = new Decimal(customerWallet.balance).minus(payload.amount);
        const providerNewBalance = new Decimal(providerWallet.balance).plus(providerNet);

        // Debit customer
        await tx.wallet.update({
          where: { id: customerWallet.id },
          data: { balance: customerNewBalance },
        });
        await tx.walletTransaction.create({
          data: {
            walletId: customerWallet.id,
            type: WalletTxType.DEBIT,
            amount: payload.amount,
            balanceAfter: customerNewBalance,
            description: `رسوم استشارة — ${payload.consultationId.slice(0, 8).toUpperCase()}`,
            refId: payload.consultationId,
            refType: 'consultation',
            idempotencyKey: debitKey,
          },
        });

        // Credit provider
        await tx.wallet.update({
          where: { id: providerWallet.id },
          data: { balance: providerNewBalance },
        });
        await tx.walletTransaction.create({
          data: {
            walletId: providerWallet.id,
            type: WalletTxType.CREDIT,
            amount: providerNet,
            balanceAfter: providerNewBalance,
            description: `مستحقات استشارة — ${payload.consultationId.slice(0, 8).toUpperCase()}`,
            refId: payload.consultationId,
            refType: 'consultation',
            idempotencyKey: creditKey,
          },
        });
      });

      this.logger.log(`Consultation charged: customer -${payload.amount} SAR, provider +${providerNet} SAR`);
    } catch (err) {
      this.logger.error(`onConsultationChargeRequired failed for ${payload.consultationId}: ${err}`);
    }
  }

  @OnEvent('wallet.debited')
  async onWalletDebited(payload: { userId: string; amount: number; newBalance: number }) {
    await this.notif.createInApp(
      payload.userId,
      '💳 تم خصم من محفظتك',
      `تم خصم ${payload.amount} ريال. رصيدك الحالي: ${payload.newBalance} ريال.`,
    );
  }

  // ── Dispute resolution notification ─────────────────────────────────────

  @OnEvent('dispute.resolved')
  async onDisputeResolved(payload: {
    disputeId: string;
    resolution: string;
    reporterId: string;
    againstId: string;
  }) {
    const resolutionLabels: Record<string, string> = {
      REFUND: 'تم استرداد المبلغ لصالحك',
      RELEASE: 'تم إطلاق المبلغ للمزود',
      SPLIT: 'تم تقسيم المبلغ بين الطرفين',
      DISMISSED: 'تم رفض النزاع',
    };
    const label = resolutionLabels[payload.resolution] ?? payload.resolution;
    await Promise.all([
      this.notif.notifyUser(
        payload.reporterId,
        '✅ تم حل النزاع',
        `قرار النزاع: ${label}. معرف النزاع: ${payload.disputeId.slice(0, 8).toUpperCase()}`,
        { disputeId: payload.disputeId },
      ),
      this.notif.notifyUser(
        payload.againstId,
        '✅ تم حل النزاع',
        `قرار النزاع: ${label}. معرف النزاع: ${payload.disputeId.slice(0, 8).toUpperCase()}`,
        { disputeId: payload.disputeId },
      ),
    ]);
    this.logger.log(`Dispute ${payload.disputeId} resolved: ${payload.resolution}`);
  }

  // ── Support ticket reopened ──────────────────────────────────────────────

  @OnEvent('support.ticket_reopened')
  async onTicketReopened(payload: { ticketId: string; userId: string }) {
    const adminEmail = this.config.get<string>('ADMIN_EMAIL', '');
    if (adminEmail) {
      await this.notif.sendEmail(
        adminEmail,
        `🔄 تذكرة دعم أُعيد فتحها — ${payload.ticketId.slice(0, 8).toUpperCase()}`,
        `<p>أعاد العميل فتح تذكرة الدعم <strong>${payload.ticketId}</strong>. يرجى المتابعة.</p>`,
      );
    }
    this.logger.log(`Support ticket reopened: ${payload.ticketId}`);
  }

  // ── Admin consultation cancelled ─────────────────────────────────────────

  @OnEvent('admin.consultation_cancelled')
  async onConsultationCancelledByAdmin(payload: {
    consultationId: string;
    adminId: string;
    reason: string;
    customerId: string;
    providerId: string;
  }) {
    await Promise.all([
      this.notif.notifyUser(
        payload.customerId,
        '❌ تم إلغاء الاستشارة',
        `ألغى المشرف الاستشارة. السبب: ${payload.reason}`,
        { consultationId: payload.consultationId },
      ),
      payload.providerId
        ? this.notif.notifyUser(
            payload.providerId,
            '❌ تم إلغاء الاستشارة',
            `ألغى المشرف الاستشارة. السبب: ${payload.reason}`,
            { consultationId: payload.consultationId },
          )
        : Promise.resolve(),
    ]);
  }

  // ── Consultation cancelled by customer or provider ───────────────────────

  @OnEvent('consultation.cancelled')
  async onConsultationCancelled(payload: {
    consultationId: string;
    cancelledBy: 'customer' | 'provider';
    customerId: string;
    providerId: string;
  }) {
    const byCustomer = payload.cancelledBy === 'customer';
    // Notify the OTHER party
    const notifyId  = byCustomer ? payload.providerId : payload.customerId;
    const notifyMsg = byCustomer
      ? 'ألغى العميل الاستشارة قبل بدء الجلسة'
      : 'ألغى المزود الاستشارة قبل بدء الجلسة';

    await this.notif.notifyUser(
      notifyId,
      '❌ تم إلغاء الاستشارة',
      notifyMsg,
      { consultationId: payload.consultationId },
    );
  }

  // ── Materials adjustment batch expired ───────────────────────────────────

  @OnEvent('materials.adjustment.batch_expired')
  async onAdjustmentBatchExpired(payload: { count: number }) {
    this.logger.warn(`${payload.count} materials adjustment requests expired (batch)`);
    const adminEmail = this.config.get<string>('ADMIN_EMAIL', '');
    if (adminEmail) {
      await this.notif.sendEmail(
        adminEmail,
        `⏰ ${payload.count} طلب تعديل مواد انتهت صلاحيته`,
        `<p>انتهت صلاحية <strong>${payload.count}</strong> طلب تعديل ميزانية مواد دون موافقة العميل.</p>`,
      );
    }
  }

  // ── Payment events ────────────────────────────────────────────────────────

  @OnEvent('payment.confirmed')
  async onPaymentConfirmed(payload: { paymentId: string; requestId: string; customerId: string; amount: number }) {
    try {
      await this.notif.notifyUser(
        payload.customerId,
        '✅ تم تأكيد الدفع',
        `تم تأكيد دفعتك بمبلغ ${payload.amount} ريال. جاري البحث عن مزود خدمة.`,
        { requestId: payload.requestId, paymentId: payload.paymentId },
      );
      this.logger.log(`Payment confirmed: ${payload.paymentId} for request ${payload.requestId}`);
    } catch (err) {
      this.logger.error(`onPaymentConfirmed failed: ${err}`);
    }
  }

  @OnEvent('payment.refund_confirmed')
  async onRefundConfirmed(payload: { paymentId: string; requestId?: string; customerId?: string; amount?: number }) {
    try {
      if (payload.customerId) {
        await this.notif.notifyUser(
          payload.customerId,
          '💸 تم تأكيد الاسترداد',
          `تم تأكيد استرداد مبلغ ${payload.amount ?? ''} ريال إلى حسابك.`,
          { paymentId: payload.paymentId },
        );
      }
      this.logger.log(`Refund confirmed for payment ${payload.paymentId}`);
    } catch (err) {
      this.logger.error(`onRefundConfirmed failed: ${err}`);
    }
  }

  @OnEvent('payment.refunded')
  async onPaymentRefunded(payload: { paymentId: string; adminId: string; reason: string }) {
    this.logger.log(`Payment refunded by admin ${payload.adminId}: ${payload.paymentId} — ${payload.reason}`);
  }

  // ── Admin user management events ─────────────────────────────────────────

  @OnEvent('admin.user_suspended')
  async onUserSuspended(payload: { targetUserId: string; adminId: string; reason: string }) {
    try {
      await this.notif.notifyUser(
        payload.targetUserId,
        '⚠️ تم تعليق حسابك',
        `تم تعليق حسابك. السبب: ${payload.reason}. للاستفسار تواصل مع الدعم.`,
        {},
      );
      this.logger.warn(`User suspended: ${payload.targetUserId} by admin ${payload.adminId}`);
    } catch (err) {
      this.logger.error(`onUserSuspended failed: ${err}`);
    }
  }

  @OnEvent('admin.user_banned')
  async onUserBanned(payload: { targetUserId: string; adminId: string; reason?: string }) {
    try {
      await this.notif.notifyUser(
        payload.targetUserId,
        '🚫 تم حظر حسابك',
        'تم حظر حسابك نهائياً. للاستفسار تواصل مع الدعم.',
        {},
      );
      this.logger.warn(`User banned: ${payload.targetUserId} by admin ${payload.adminId}`);
    } catch (err) {
      this.logger.error(`onUserBanned failed: ${err}`);
    }
  }

  // ── Auth events ───────────────────────────────────────────────────────────

  @OnEvent('auth.login')
  async onLogin(payload: { userId: string; ip?: string; userAgent?: string }) {
    this.logger.log(`Login: user ${payload.userId} from ${payload.ip ?? 'unknown'}`);
  }

  @OnEvent('auth.password_changed')
  async onPasswordChanged(payload: { userId: string }) {
    try {
      const user = await this.prisma.user.findUnique({ where: { id: payload.userId }, select: { email: true } });
      if (user?.email) {
        await this.notif.sendEmail(
          user.email,
          '🔐 تم تغيير كلمة مرورك',
          '<p>تم تغيير كلمة مرور حسابك على منصة خدمة. إذا لم تقم بهذا الإجراء، تواصل مع الدعم فوراً.</p>',
        );
      }
    } catch (err) {
      this.logger.error(`onPasswordChanged notification failed: ${err}`);
    }
  }

  // ── Request status events ─────────────────────────────────────────────────

  @OnEvent('request.status_changed')
  async onRequestStatusChanged(payload: { requestId: string; status: string; providerId?: string; customerId?: string }) {
    try {
      const statusLabels: Record<string, string> = {
        IN_PROGRESS: 'بدأ مزود الخدمة في تنفيذ طلبك.',
        COMPLETED: 'تم إكمال طلب الخدمة. يرجى تأكيد الاستلام.',
      };
      const bodyAr = statusLabels[payload.status];
      if (!bodyAr) return;
      // Notify customer if we have their id; otherwise look it up
      let customerId = payload.customerId;
      if (!customerId) {
        const req = await this.prisma.serviceRequest.findUnique({
          where: { id: payload.requestId },
          select: { customerId: true },
        });
        customerId = req?.customerId;
      }
      if (customerId) {
        await this.notif.notifyUser(
          customerId,
          '🔔 تحديث حالة الطلب',
          bodyAr,
          { requestId: payload.requestId },
        );
      }
    } catch (err) {
      this.logger.error(`onRequestStatusChanged failed: ${err}`);
    }
  }

  // ── Materials usage logged ────────────────────────────────────────────────

  @OnEvent('materials.usage.logged')
  async onMaterialsUsageLogged(payload: { requestId: string; amount: number; description?: string }) {
    try {
      const request = await this.prisma.serviceRequest.findUnique({
        where: { id: payload.requestId },
        select: { customerId: true },
      });
      if (request?.customerId) {
        await this.notif.notifyUser(
          request.customerId,
          '🛒 تم تسجيل مشتريات مواد',
          `سجّل المزود شراء مواد بقيمة ${payload.amount} ريال${payload.description ? ': ' + payload.description : ''}.`,
          { requestId: payload.requestId },
        );
      }
    } catch (err) {
      this.logger.error(`onMaterialsUsageLogged failed: ${err}`);
    }
  }

  // ── Wallet withdrawal events ──────────────────────────────────────────────

  @OnEvent('wallet.withdrawal_requested')
  async onWithdrawalRequested(payload: { userId: string; amount: number; withdrawalId: string }) {
    try {
      await this.notif.notifyUser(
        payload.userId,
        'طلب سحب مستلم',
        `تم استلام طلب سحبك بمبلغ ${payload.amount} ريال وهو قيد المراجعة`,
        { withdrawalId: payload.withdrawalId },
      );
    } catch (err) {
      this.logger.error(`onWithdrawalRequested notification failed: ${err}`);
    }
  }

  @OnEvent('wallet.withdrawal_completed')
  async onWithdrawalCompleted(payload: { userId: string; amount: number; withdrawalId?: string }) {
    try {
      await this.notif.notifyUser(
        payload.userId,
        'تم تحويل المبلغ',
        `تمت الموافقة على طلب السحب وتحويل ${payload.amount} ريال إلى حسابك البنكي`,
        payload.withdrawalId ? { withdrawalId: payload.withdrawalId } : {},
      );
    } catch (err) {
      this.logger.error(`onWithdrawalCompleted notification failed: ${err}`);
    }
  }

  @OnEvent('wallet.withdrawal_rejected')
  async onWithdrawalRejected(payload: { userId: string; amount: number; withdrawalId?: string; reason?: string }) {
    try {
      await this.notif.notifyUser(
        payload.userId,
        'طلب السحب مرفوض',
        `تم رفض طلب سحب مبلغ ${payload.amount} ريال${payload.reason ? ': ' + payload.reason : ''}`,
        payload.withdrawalId ? { withdrawalId: payload.withdrawalId } : {},
      );
    } catch (err) {
      this.logger.error(`onWithdrawalRejected notification failed: ${err}`);
    }
  }

  // ── Referral reward notifications ────────────────────────────────────────

  @OnEvent('referral.credited_referrer')
  async onReferralCreditedReferrer(payload: { userId: string; refereeId: string; amount: number }) {
    try {
      await this.notif.notifyUser(
        payload.userId,
        '🎁 مكافأة الإحالة',
        `حصلت على ${payload.amount} ريال مكافأة لدعوتك صديقاً للانضمام إلى خدمة`,
        { refereeId: payload.refereeId, amount: payload.amount },
      );
    } catch (err) {
      this.logger.error(`onReferralCreditedReferrer failed: ${err}`);
    }
  }

  @OnEvent('referral.credited_referee')
  async onReferralCreditedReferee(payload: { userId: string; referrerId: string; amount: number }) {
    try {
      await this.notif.notifyUser(
        payload.userId,
        '🎉 مكافأة ترحيب',
        `تم إضافة ${payload.amount} ريال إلى محفظتك كمكافأة ترحيب بانضمامك عبر رابط الإحالة`,
        { referrerId: payload.referrerId, amount: payload.amount },
      );
    } catch (err) {
      this.logger.error(`onReferralCreditedReferee failed: ${err}`);
    }
  }

  // ── Tender bid submitted ──────────────────────────────────────────────────

  @OnEvent('tender.bid_submitted')
  async onBidSubmitted(payload: { tenderId: string; bidId: string; userId: string }) {
    try {
      const tender = await this.prisma.tender.findUnique({
        where: { id: payload.tenderId },
        include: { company: { select: { ownerId: true } } },
      });
      if (tender?.company?.ownerId) {
        await this.notif.notifyUser(
          tender.company.ownerId,
          '📋 عرض سعر جديد على مناقصتك',
          'تلقيت عرض سعر جديد على إحدى مناقصاتك. راجع العروض من لوحة التحكم.',
          { tenderId: payload.tenderId },
        );
      }
    } catch (err) {
      this.logger.error(`onBidSubmitted failed: ${err}`);
    }
  }
}
