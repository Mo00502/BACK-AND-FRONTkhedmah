import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditAction } from '@prisma/client';

interface AuditEvent {
  userId?: string;
  action: AuditAction;
  entityType: string;
  entityId?: string;
  metadata?: any;
  ipAddress?: string;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private prisma: PrismaService) {}

  async log(event: AuditEvent) {
    await this.prisma.auditLog.create({ data: event });
  }

  // ── Generic audit event ────────────────────────────────────────────────────
  @OnEvent('audit.log')
  handleAuditEvent(event: AuditEvent) {
    this.log(event).catch((err) => this.logger.error('Audit log failed', err));
  }

  // ── Auth ───────────────────────────────────────────────────────────────────
  @OnEvent('auth.email_verification_requested')
  handleUserRegistered(event: { userId: string; email: string }) {
    this.log({
      userId: event.userId,
      action: AuditAction.CREATE,
      entityType: 'user',
      entityId: event.userId,
      metadata: { email: event.email },
    });
  }

  @OnEvent('auth.login')
  handleLogin(event: { userId: string; ip?: string }) {
    this.log({
      userId: event.userId,
      action: AuditAction.UPDATE,
      entityType: 'session',
      metadata: { ip: event.ip },
    });
  }

  @OnEvent('auth.password_reset')
  handlePasswordReset(event: { userId: string; ip?: string }) {
    this.log({
      userId: event.userId,
      action: AuditAction.UPDATE,
      entityType: 'password',
      metadata: { event: 'reset', ip: event.ip },
    });
  }

  @OnEvent('auth.password_changed')
  handlePasswordChanged(event: { userId: string }) {
    this.log({
      userId: event.userId,
      action: AuditAction.UPDATE,
      entityType: 'password',
      metadata: { event: 'changed' },
    });
  }

  // ── Requests ───────────────────────────────────────────────────────────────
  @OnEvent('request.created')
  handleRequestCreated(event: { requestId: string; customerId: string; serviceId: string }) {
    this.log({
      userId: event.customerId,
      action: AuditAction.CREATE,
      entityType: 'service_request',
      entityId: event.requestId,
      metadata: { serviceId: event.serviceId },
    });
  }

  @OnEvent('quote.accepted')
  handleQuoteAccepted(event: {
    quoteId: string;
    requestId: string;
    customerId: string;
    amount: number;
  }) {
    this.log({
      userId: event.customerId,
      action: AuditAction.APPROVE,
      entityType: 'quote',
      entityId: event.quoteId,
      metadata: { requestId: event.requestId, amount: event.amount },
    });
  }

  // ── Payments & Escrow ──────────────────────────────────────────────────────
  @OnEvent('payment.confirmed')
  handlePaymentConfirmed(event: { paymentId: string; requestId: string }) {
    this.log({
      action: AuditAction.PAYMENT,
      entityType: 'payment',
      entityId: event.paymentId,
      metadata: { requestId: event.requestId },
    });
  }

  @OnEvent('escrow.released')
  handleEscrowReleased(event: { requestId: string; providerId?: string }) {
    this.log({
      action: AuditAction.ESCROW_RELEASE,
      entityType: 'escrow',
      entityId: event.requestId,
      metadata: { providerId: event.providerId },
    });
  }

  @OnEvent('payment.refunded')
  handlePaymentRefunded(event: { paymentId: string; adminId: string; reason: string }) {
    this.log({
      userId: event.adminId,
      action: AuditAction.ESCROW_REFUND,
      entityType: 'payment',
      entityId: event.paymentId,
      metadata: { reason: event.reason },
    });
  }

  // ── Tenders ────────────────────────────────────────────────────────────────
  @OnEvent('tender.awarded')
  handleTenderAwarded(event: { tenderId: string; winnerId: string; adminId?: string }) {
    this.log({
      userId: event.adminId,
      action: AuditAction.APPROVE,
      entityType: 'tender',
      entityId: event.tenderId,
      metadata: { winnerId: event.winnerId },
    });
  }

  // ── Disputes ───────────────────────────────────────────────────────────────
  @OnEvent('dispute.opened')
  handleDisputeOpened(event: { disputeId: string; requestId: string; reporterId: string }) {
    this.log({
      userId: event.reporterId,
      action: AuditAction.CREATE,
      entityType: 'dispute',
      entityId: event.disputeId,
      metadata: { requestId: event.requestId },
    });
  }

  // ── Admin actions ──────────────────────────────────────────────────────────
  @OnEvent('admin.user_suspended')
  handleUserSuspended(event: { targetUserId: string; adminId: string; reason: string }) {
    this.log({
      userId: event.adminId,
      action: AuditAction.SUSPEND,
      entityType: 'user',
      entityId: event.targetUserId,
      metadata: { reason: event.reason },
    });
  }

  @OnEvent('admin.user_banned')
  handleUserBanned(event: { targetUserId: string; adminId: string }) {
    this.log({
      userId: event.adminId,
      action: AuditAction.BAN,
      entityType: 'user',
      entityId: event.targetUserId,
    });
  }

  // ── Wallet withdrawals ─────────────────────────────────────────────────────
  @OnEvent('wallet.withdrawal_requested')
  handleWithdrawalRequested(event: { userId: string; amount: number; withdrawalId: string }) {
    this.log({
      userId: event.userId,
      action: AuditAction.CREATE,
      entityType: 'withdrawal',
      entityId: event.withdrawalId,
      metadata: { amount: event.amount },
    });
  }

  @OnEvent('wallet.withdrawal_completed')
  handleWithdrawalCompleted(event: { userId: string; amount: number }) {
    this.log({
      action: AuditAction.PAYMENT,
      entityType: 'withdrawal',
      metadata: { userId: event.userId, amount: event.amount },
    });
  }

  // ── Refund failure ─────────────────────────────────────────────────────────
  @OnEvent('payment.refund_failed')
  handleRefundFailed(event: {
    paymentId: string;
    adminId: string;
    reason: string;
    detail: unknown;
  }) {
    this.log({
      userId: event.adminId,
      action: AuditAction.PAYMENT,
      entityType: 'payment_refund_failed',
      entityId: event.paymentId,
      metadata: { reason: event.reason, detail: event.detail },
    }).catch((err) => this.logger.error('Audit log for refund_failed failed', err));
  }

  // ── Security events ────────────────────────────────────────────────────────
  @OnEvent('auth.login_failed')
  handleLoginFailed(event: { identifier: string; reason: string; ip?: string }) {
    this.log({
      action: AuditAction.LOGIN,
      entityType: 'auth_login_failed',
      metadata: { identifier: event.identifier, reason: event.reason },
      ipAddress: event.ip,
    }).catch((err) => this.logger.error('Audit log for login_failed failed', err));
  }

  @OnEvent('auth.token_reuse_detected')
  handleTokenReuse(event: { userId: string; tokenId: string; ip?: string }) {
    this.log({
      userId: event.userId,
      action: AuditAction.LOGOUT,
      entityType: 'auth_token_reuse',
      entityId: event.tokenId,
      metadata: { ip: event.ip },
    }).catch((err) => this.logger.error('Audit log for token_reuse failed', err));
  }

  // ── Admin query: audit log viewer ─────────────────────────────────────────
  async getLogs(filters: {
    userId?: string;
    entityType?: string;
    action?: AuditAction;
    page?: number;
    limit?: number;
  }) {
    const { page = 1, limit = 50 } = filters;
    const skip = (page - 1) * limit;
    const where: any = {};
    if (filters.userId) where.userId = filters.userId;
    if (filters.entityType) where.entityType = filters.entityType;
    if (filters.action) where.action = filters.action;

    const [logs, total] = await Promise.all([
      this.prisma.auditLog.findMany({ where, skip, take: limit, orderBy: { createdAt: 'desc' } }),
      this.prisma.auditLog.count({ where }),
    ]);

    return { logs, total, page, pages: Math.ceil(total / limit) };
  }
}
