import { Injectable, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../prisma/prisma.service';
import { UserStatus, ProviderVerificationStatus, DisputeStatus, EquipmentStatus } from '@prisma/client';
import { PaginationDto, paginate } from '../../common/dto/pagination.dto';

@Injectable()
export class AdminService {
  constructor(
    private prisma: PrismaService,
    private events: EventEmitter2,
  ) {}

  async getDashboardStats() {
    const [
      totalUsers,
      totalProviders,
      totalRequests,
      completedRequests,
      totalRevenue,
      pendingVerifications,
      recentRequests,
    ] = await Promise.all([
      this.prisma.user.count({ where: { deletedAt: null } }),
      this.prisma.providerProfile.count(),
      this.prisma.serviceRequest.count(),
      this.prisma.serviceRequest.count({ where: { status: 'COMPLETED' } }),
      this.prisma.escrow.aggregate({
        where: { status: 'RELEASED' },
        _sum: { platformFee: true },
      }),
      this.prisma.providerProfile.count({
        where: { verificationStatus: { in: ['PENDING_REVIEW', 'UNDER_REVIEW'] } },
      }),
      this.prisma.serviceRequest.findMany({
        take: 10,
        orderBy: { createdAt: 'desc' },
        include: { customer: { include: { profile: true } }, service: true },
      }),
    ]);

    return {
      totalUsers,
      totalProviders,
      totalRequests,
      completedRequests,
      platformRevenue: totalRevenue._sum.platformFee || 0,
      pendingVerifications,
      recentRequests,
    };
  }

  async getMonthlyStats() {
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

    const requests = await this.prisma.$queryRaw<any[]>`
      SELECT
        DATE_TRUNC('month', created_at) as month,
        COUNT(*) as total,
        COUNT(CASE WHEN status = 'COMPLETED' THEN 1 END) as completed
      FROM service_requests
      WHERE created_at >= ${sixMonthsAgo}
      GROUP BY DATE_TRUNC('month', created_at)
      ORDER BY month ASC
    `;

    const revenue = await this.prisma.$queryRaw<any[]>`
      SELECT
        DATE_TRUNC('month', released_at) as month,
        SUM(platform_fee) as fee
      FROM escrow
      WHERE status = 'RELEASED' AND released_at >= ${sixMonthsAgo}
      GROUP BY DATE_TRUNC('month', released_at)
      ORDER BY month ASC
    `;

    return { requests, revenue };
  }

  async getPendingVerifications(page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const [providers, total] = await Promise.all([
      this.prisma.providerProfile.findMany({
        where: { verificationStatus: { in: ['PENDING_REVIEW', 'UNDER_REVIEW'] } },
        include: { user: { include: { profile: true } } },
        skip,
        take: limit,
        orderBy: { docsSubmittedAt: 'asc' },
      }),
      this.prisma.providerProfile.count({
        where: { verificationStatus: { in: ['PENDING_REVIEW', 'UNDER_REVIEW'] } },
      }),
    ]);
    return { providers, total };
  }

  async startReview(providerId: string) {
    const profile = await this.prisma.providerProfile.findUnique({ where: { id: providerId } });
    if (!profile) throw new NotFoundException('Provider not found');
    if (profile.verificationStatus !== 'PENDING_REVIEW') {
      throw new BadRequestException('Provider is not in PENDING_REVIEW state');
    }
    return this.prisma.providerProfile.update({
      where: { id: providerId },
      data: { verificationStatus: 'UNDER_REVIEW', reviewStartedAt: new Date() },
    });
  }

  async approveProvider(providerId: string) {
    const profile = await this.prisma.providerProfile.findUnique({
      where: { id: providerId },
      include: { user: true },
    });
    if (!profile) throw new NotFoundException('Provider not found');

    if (!['PENDING_REVIEW', 'UNDER_REVIEW'].includes(profile.verificationStatus as string)) {
      throw new BadRequestException(
        `Cannot approve provider with status ${profile.verificationStatus}. Must be PENDING_REVIEW or UNDER_REVIEW.`,
      );
    }

    const updated = await this.prisma.providerProfile.update({
      where: { id: providerId },
      data: {
        verificationStatus: 'APPROVED',
        verified: true,
        approvedAt: new Date(),
      },
    });

    this.events.emit('provider.approved', { userId: profile.userId, email: profile.user.email });
    this.events.emit('audit.log', { action: 'APPROVE', entityType: 'ProviderProfile', entityId: providerId });
    return updated;
  }

  async rejectProvider(providerId: string, reason: string) {
    const profile = await this.prisma.providerProfile.findUnique({
      where: { id: providerId },
      include: { user: true },
    });
    if (!profile) throw new NotFoundException('Provider not found');

    const updated = await this.prisma.providerProfile.update({
      where: { id: providerId },
      data: {
        verificationStatus: 'REJECTED',
        verified: false,
        rejectedAt: new Date(),
        rejectionReason: reason,
      },
    });

    this.events.emit('provider.rejected', {
      userId: profile.userId,
      email: profile.user.email,
      reason,
    });
    this.events.emit('audit.log', { action: 'REJECT', entityType: 'ProviderProfile', entityId: providerId, metadata: { reason } });
    return updated;
  }

  async suspendProvider(providerId: string, reason: string) {
    const profile = await this.prisma.providerProfile.findUnique({
      where: { id: providerId },
      select: { id: true, userId: true, verificationStatus: true },
    });
    if (!profile) throw new NotFoundException('Provider not found');
    if (profile.verificationStatus !== 'APPROVED') {
      throw new BadRequestException('Only approved providers can be suspended');
    }

    await this.prisma.$transaction([
      this.prisma.providerProfile.update({
        where: { id: providerId },
        data: {
          verificationStatus: 'SUSPENDED',
          verified: false,
          suspendedAt: new Date(),
          suspensionReason: reason,
        },
      }),
      this.prisma.user.update({
        where: { id: profile.userId },
        data: { suspended: true, suspendedReason: reason, status: UserStatus.SUSPENDED },
      }),
    ]);

    return { message: 'Provider suspended successfully' };
  }

  // ── User moderation ──────────────────────────────────────────────────────
  async suspendUser(targetUserId: string, reason: string, adminId?: string) {
    const updated = await this.prisma.user.update({
      where: { id: targetUserId },
      data: { suspended: true, suspendedReason: reason, status: UserStatus.SUSPENDED },
    });
    this.events.emit('admin.user_suspended', {
      targetUserId,
      adminId: adminId ?? 'system',
      reason,
    });
    this.events.emit('audit.log', { userId: adminId, action: 'SUSPEND', entityType: 'User', entityId: targetUserId, metadata: { reason } });
    return updated;
  }

  async reinstateUser(userId: string) {
    const [user] = await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: { suspended: false, suspendedReason: null, status: UserStatus.ACTIVE },
      }),
      this.prisma.providerProfile.updateMany({
        where: { userId, verificationStatus: ProviderVerificationStatus.SUSPENDED },
        data: {
          verificationStatus: ProviderVerificationStatus.APPROVED,
          verified: true,
          suspendedAt: null,
          suspensionReason: null,
        },
      }),
    ]);
    return user;
  }

  async deleteUser(userId: string) {
    // Soft-delete — preserves audit trail
    return this.prisma.user.update({
      where: { id: userId },
      data: { deletedAt: new Date() },
    });
  }

  // ── Dispute resolution ───────────────────────────────────────────────────
  async getDisputeById(disputeId: string) {
    const dispute = await this.prisma.dispute.findUnique({
      where: { id: disputeId },
      include: {
        request: { include: { service: true } },
        reporter: { include: { profile: true } },
        against: { include: { profile: true } },
      },
    });
    if (!dispute) throw new NotFoundException('Dispute not found');
    return dispute;
  }

  async getDisputes(page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const where = { status: { in: [DisputeStatus.OPEN, DisputeStatus.UNDER_REVIEW] } };
    const [disputes, total] = await Promise.all([
      this.prisma.dispute.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'asc' },
        include: {
          request: { include: { service: true } },
          reporter: { include: { profile: true } },
          against: { include: { profile: true } },
        },
      }),
      this.prisma.dispute.count({ where }),
    ]);
    return { disputes, total };
  }

  async resolveDispute(
    disputeId: string,
    adminId: string,
    resolution: 'REFUND' | 'RELEASE' | 'SPLIT' | 'DISMISSED',
    notes: string,
  ) {
    const dispute = await this.prisma.dispute.findUnique({
      where: { id: disputeId },
      include: { request: { include: { escrow: true } } },
    });
    if (!dispute) throw new NotFoundException('Dispute not found');

    // Conflict-of-interest guard: an admin who is a party to this dispute
    // must not be allowed to resolve it in their own favour.
    if (dispute.reporterId === adminId || dispute.againstId === adminId) {
      throw new ForbiddenException('لا يمكن للمشرف حل نزاع هو طرف فيه — يجب تعيين مشرف آخر');
    }

    const escrow = dispute.request?.escrow;
    const escrowHeld = escrow?.status === 'HELD';

    // For SPLIT resolution: validate amounts before touching any DB state
    if (resolution === 'SPLIT' && escrowHeld && escrow) {
      const escrowAmount = Number(escrow.amount);
      if (escrowAmount <= 0) {
        throw new BadRequestException('Escrow amount must be > 0 for a SPLIT resolution');
      }
      // Use the actual stored platformFee — never recalculate from amount (race condition risk)
      const storedFee = Number(escrow.platformFee ?? 0);
      const halfAmount = escrowAmount / 2;
      if (storedFee >= halfAmount) {
        throw new BadRequestException(
          `Platform fee (${storedFee} SAR) exceeds half the escrow (${halfAmount} SAR) — ` +
          `SPLIT would result in zero or negative provider credit. Use REFUND or RELEASE instead.`,
        );
      }
    }

    // Use interactive transaction so all DB changes are atomic
    await this.prisma.$transaction(async (tx) => {
      await tx.dispute.update({
        where: { id: disputeId },
        data: {
          status: 'RESOLVED',
          resolvedBy: adminId,
          resolvedAt: new Date(),
          resolutionNotes: notes,
          resolution,
        },
      });

      if (!escrowHeld || !escrow) return;

      if (resolution === 'REFUND') {
        // Guard: only transition from HELD — prevents RELEASED→REFUNDED corruption
        const { count } = await tx.escrow.updateMany({
          where: { id: escrow.id, status: 'HELD' },
          data: { status: 'REFUNDED', releasedAt: new Date() },
        });
        if (count === 0) throw new BadRequestException('Escrow is no longer HELD — cannot refund');
        await tx.serviceRequest.update({
          where: { id: dispute.requestId },
          data: { status: 'CANCELLED' },
        });
      } else if (resolution === 'RELEASE' || resolution === 'DISMISSED') {
        const { count } = await tx.escrow.updateMany({
          where: { id: escrow.id, status: 'HELD' },
          data: { status: 'RELEASED', releasedAt: new Date() },
        });
        if (count === 0) throw new BadRequestException('Escrow is no longer HELD — cannot release');
        await tx.serviceRequest.update({
          where: { id: dispute.requestId },
          data: { status: 'COMPLETED', completedAt: new Date() },
        });
      } else if (resolution === 'SPLIT') {
        const { count } = await tx.escrow.updateMany({
          where: { id: escrow.id, status: 'HELD' },
          data: { status: 'RELEASED', releasedAt: new Date() },
        });
        if (count === 0) throw new BadRequestException('Escrow is no longer HELD — cannot split');
        await tx.serviceRequest.update({
          where: { id: dispute.requestId },
          data: { status: 'COMPLETED', completedAt: new Date() },
        });
      }
    });

    // Emit financial events after transaction commits so wallet credits are safe
    if (escrowHeld && escrow) {
      if (resolution === 'RELEASE' || resolution === 'DISMISSED') {
        this.events.emit('escrow.released', {
          requestId: dispute.requestId,
          providerId: dispute.request?.providerId,
          source: 'dispute_resolution',
        });
      } else if (resolution === 'REFUND') {
        this.events.emit('dispute.refund_ordered', {
          disputeId,
          requestId: dispute.requestId,
          paymentId: escrow.paymentId,
          adminId,
        });
      } else if (resolution === 'SPLIT') {
        const halfAmount = Number(escrow.amount) / 2;
        // Use the stored platformFee — never recalculate after validation above
        const platformFeeHalf = Number(escrow.platformFee ?? 0) / 2;
        this.events.emit('dispute.split_release', {
          requestId: dispute.requestId,
          providerId: dispute.request?.providerId,
          providerAmount: +(halfAmount - platformFeeHalf).toFixed(2),
          escrowId: escrow.id,
        });
        this.events.emit('dispute.split_refund', {
          disputeId,
          requestId: dispute.requestId,
          paymentId: escrow.paymentId,
          refundAmount: +halfAmount.toFixed(2),
          adminId,
        });
      }
    }

    this.events.emit('dispute.resolved', {
      disputeId,
      resolution,
      adminId,
      reporterId: dispute.reporterId,
      againstId: dispute.againstId,
    });
    this.events.emit('audit.log', { userId: adminId, action: 'UPDATE', entityType: 'Dispute', entityId: disputeId, metadata: { resolution } });

    return { message: `Dispute resolved: ${resolution}` };
  }

  // ── System health snapshot ───────────────────────────────────────────────
  async getSystemHealth() {
    const now = new Date();
    const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const [
      newUsersToday,
      requestsToday,
      failedPaymentsToday,
      openDisputes,
      pendingVerifications,
      heldEscrow,
      lastJobLogs,
    ] = await Promise.all([
      this.prisma.user.count({ where: { createdAt: { gte: dayAgo }, deletedAt: null } }),
      this.prisma.serviceRequest.count({ where: { createdAt: { gte: dayAgo } } }),
      this.prisma.payment.count({ where: { status: 'FAILED', createdAt: { gte: dayAgo } } }),
      this.prisma.dispute.count({ where: { status: 'OPEN' } }),
      this.prisma.providerProfile.count({
        where: { verificationStatus: { in: ['PENDING_REVIEW', 'UNDER_REVIEW'] } },
      }),
      this.prisma.escrow.aggregate({
        where: { status: 'HELD' },
        _sum: { amount: true },
        _count: { id: true },
      }),
      this.prisma.scheduledJobLog.findMany({
        orderBy: { ranAt: 'desc' },
        take: 10,
      }),
    ]);

    return {
      timestamp: now,
      activity: { newUsersToday, requestsToday, failedPaymentsToday },
      pendingActions: { openDisputes, pendingVerifications },
      escrow: { count: heldEscrow._count.id, totalHeld: Number(heldEscrow._sum.amount ?? 0) },
      schedulerHealth: lastJobLogs,
    };
  }

  // ── Commission oversight ─────────────────────────────────────────────────
  async getOverdueCommissions(page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const where = { status: 'OVERDUE' as const };
    const [items, total] = await Promise.all([
      this.prisma.tenderCommission.findMany({
        where,
        include: { tender: true, company: { include: { owner: { include: { profile: true } } } } },
        orderBy: { overdueAt: 'asc' },
        skip,
        take: limit,
      }),
      this.prisma.tenderCommission.count({ where }),
    ]);
    return { items, total, page, pages: Math.ceil(total / limit) };
  }

  // ── Consultation management ───────────────────────────────────────────────
  async getConsultations(page = 1, limit = 20, status?: string) {
    const skip = (page - 1) * limit;
    const where: any = {};
    if (status) where.status = status;

    const [items, total] = await Promise.all([
      this.prisma.consultation.findMany({
        where,
        include: {
          service: { select: { nameAr: true, icon: true } },
          customer: { include: { profile: true } },
          provider: { include: { profile: true } },
        },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.consultation.count({ where }),
    ]);

    return { items, total, page, pages: Math.ceil(total / limit) };
  }

  // ── Audit log viewer ─────────────────────────────────────────────────────
  async getAuditLogs(page: number, limit: number, filters: { action?: string; entityType?: string; userId?: string }) {
    const skip = (page - 1) * limit;
    const where: any = {};
    if (filters.action) where.action = filters.action;
    if (filters.entityType) where.entityType = filters.entityType;
    if (filters.userId) where.userId = filters.userId;

    const [logs, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        include: { user: { select: { id: true, email: true, role: true } } },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return { data: logs, total, page, limit, pages: Math.ceil(total / limit) };
  }

  // ── Equipment moderation ──────────────────────────────────────────────────
  async getPendingEquipment(dto: PaginationDto) {
    const [items, total] = await Promise.all([
      this.prisma.equipment.findMany({
        where: { status: EquipmentStatus.PENDING },
        include: { owner: { include: { profile: true } } },
        skip: dto.skip,
        take: dto.limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.equipment.count({ where: { status: EquipmentStatus.PENDING } }),
    ]);
    return paginate(items, total, dto);
  }

  async approveEquipment(equipmentId: string, adminId: string) {
    const equipment = await this.prisma.equipment.findUnique({ where: { id: equipmentId } });
    if (!equipment) throw new NotFoundException('Equipment not found');
    if (equipment.status !== EquipmentStatus.PENDING) {
      throw new BadRequestException(`Equipment is not in PENDING status (current: ${equipment.status})`);
    }

    const updated = await this.prisma.equipment.update({
      where: { id: equipmentId },
      data: { status: EquipmentStatus.ACTIVE },
    });

    this.events.emit('equipment.approved', { equipmentId, adminId });
    return updated;
  }

  async rejectEquipment(equipmentId: string, adminId: string, reason: string) {
    const equipment = await this.prisma.equipment.findUnique({ where: { id: equipmentId } });
    if (!equipment) throw new NotFoundException('Equipment not found');
    if (equipment.status !== EquipmentStatus.PENDING) {
      throw new BadRequestException(`Equipment is not in PENDING status (current: ${equipment.status})`);
    }

    const updated = await this.prisma.equipment.update({
      where: { id: equipmentId },
      data: { status: EquipmentStatus.SUSPENDED },
    });

    this.events.emit('equipment.rejected', { equipmentId, adminId, reason });
    return updated;
  }

  async cancelConsultationByAdmin(consultationId: string, adminId: string, reason: string) {
    const c = await this.prisma.consultation.findUnique({ where: { id: consultationId } });
    if (!c) throw new NotFoundException('Consultation not found');

    const terminal = ['COMPLETED', 'CANCELLED', 'REJECTED'];
    if (terminal.includes(c.status)) {
      throw new BadRequestException(`Cannot cancel a consultation in status: ${c.status}`);
    }

    const updated = await this.prisma.consultation.update({
      where: { id: consultationId },
      data: { status: 'CANCELLED' },
    });

    this.events.emit('admin.consultation_cancelled', {
      consultationId,
      adminId,
      reason,
      customerId: c.customerId,
      providerId: c.providerId,
    });

    return updated;
  }
}
