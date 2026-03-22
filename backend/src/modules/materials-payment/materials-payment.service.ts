import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../prisma/prisma.service';
import { MaterialsPaymentStatus } from '@prisma/client';

const ADJUSTMENT_EXPIRY_HOURS = 24; // customer has 24h to respond

@Injectable()
export class MaterialsPaymentService {
  private readonly logger = new Logger(MaterialsPaymentService.name);

  constructor(
    private prisma: PrismaService,
    private events: EventEmitter2,
  ) {}

  // ── Called by PaymentsService on webhook success ──────────────────────────
  async create(requestId: string, paymentId: string, estimatedAmount: number, paidAmount: number) {
    const mp = await this.prisma.materialsPayment.create({
      data: {
        requestId,
        paymentId,
        estimatedAmount,
        paidAmount,
        usedAmount: 0,
        refundedAmount: 0,
        status: MaterialsPaymentStatus.PAID_AVAILABLE,
      },
    });
    this.events.emit('materials.payment.funded', { requestId, amount: paidAmount });
    return mp;
  }

  // ── Get full summary for an order ────────────────────────────────────────
  async getSummary(requestId: string, userId: string) {
    const mp = await this.prisma.materialsPayment.findUnique({
      where: { requestId },
      include: {
        usageLogs: {
          include: { receipts: true },
          orderBy: { createdAt: 'desc' },
        },
        adjustmentRequests: { orderBy: { requestedAt: 'desc' } },
      },
    });
    if (!mp) throw new NotFoundException('Materials payment record not found');

    // Verify caller is customer, provider, or admin
    const request = await this.prisma.serviceRequest.findUnique({
      where: { id: requestId },
      select: { customerId: true, providerId: true },
    });
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });
    const isParticipant = request?.customerId === userId || request?.providerId === userId;
    const isAdmin = ['ADMIN', 'SUPER_ADMIN', 'SUPPORT'].includes(user?.role ?? '');
    if (!isParticipant && !isAdmin) throw new ForbiddenException('Access denied');

    const remaining = Number(mp.paidAmount) - Number(mp.usedAmount) - Number(mp.refundedAmount);

    return {
      ...mp,
      remainingAmount: +remaining.toFixed(2),
    };
  }

  // ── Provider logs a materials purchase ───────────────────────────────────
  async logUsage(
    providerId: string,
    requestId: string,
    amount: number,
    description: string,
    purchasedAt: Date,
  ) {
    const mp = await this._getAndValidateForProvider(providerId, requestId);

    const remaining = Number(mp.paidAmount) - Number(mp.usedAmount) - Number(mp.refundedAmount);
    if (amount > remaining) {
      throw new BadRequestException(
        `Amount exceeds remaining materials balance. Remaining: SAR ${remaining.toFixed(2)}`,
      );
    }

    const [log] = await this.prisma.$transaction([
      this.prisma.materialsUsageLog.create({
        data: {
          materialsPaymentId: mp.id,
          amount,
          description,
          purchasedAt,
          loggedById: providerId,
          reviewStatus: 'PENDING',
        },
      }),
      this.prisma.materialsPayment.update({
        where: { id: mp.id },
        data: {
          usedAmount: { increment: amount },
          status:
            remaining - amount <= 0
              ? MaterialsPaymentStatus.FULLY_USED
              : MaterialsPaymentStatus.PARTIALLY_USED,
        },
      }),
    ]);

    this.events.emit('materials.usage.logged', { requestId, providerId, amount, logId: log.id });
    return log;
  }

  // ── Provider uploads receipt/proof for a usage log ───────────────────────
  async uploadReceipt(
    providerId: string,
    usageLogId: string,
    fileUrl: string,
    fileType: string,
    notes?: string,
  ) {
    const log = await this.prisma.materialsUsageLog.findUnique({
      where: { id: usageLogId },
    });
    if (!log) throw new NotFoundException('Usage log not found');
    if (log.loggedById !== providerId) throw new ForbiddenException('Not your usage log');

    return this.prisma.materialsReceipt.create({
      data: {
        usageLogId,
        fileUrl,
        fileType: (fileType ?? 'RECEIPT') as any,
        uploadedById: providerId,
        notes,
      },
    });
  }

  // ── Provider requests more budget when estimate was too low ──────────────
  async requestAdjustment(
    providerId: string,
    requestId: string,
    additionalAmount: number,
    reason: string,
    itemBreakdown?: any,
  ) {
    const mp = await this._getAndValidateForProvider(providerId, requestId);

    // Only one pending adjustment at a time
    const existing = await this.prisma.materialsAdjustmentRequest.findFirst({
      where: { materialsPaymentId: mp.id, status: 'PENDING' },
    });
    if (existing) {
      throw new BadRequestException('An adjustment request is already pending customer approval');
    }

    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + ADJUSTMENT_EXPIRY_HOURS);

    const adj = await this.prisma.materialsAdjustmentRequest.create({
      data: {
        materialsPaymentId: mp.id,
        requestedAdditionalAmount: additionalAmount,
        reason,
        itemBreakdown,
        expiresAt,
        status: 'PENDING',
      },
    });

    this.events.emit('materials.adjustment.requested', {
      requestId,
      providerId,
      amount: additionalAmount,
      adjustmentId: adj.id,
      expiresAt,
    });

    return adj;
  }

  // ── Customer approves or rejects an adjustment request ───────────────────
  async respondToAdjustment(customerId: string, adjustmentId: string, approve: boolean) {
    const adj = await this.prisma.materialsAdjustmentRequest.findUnique({
      where: { id: adjustmentId },
      include: { materialsPayment: { include: { request: true } } },
    });
    if (!adj) throw new NotFoundException('Adjustment request not found');
    if (adj.materialsPayment.request.customerId !== customerId) {
      throw new ForbiddenException('Only the order customer can respond to adjustment requests');
    }
    if (adj.status !== 'PENDING') {
      throw new BadRequestException('Adjustment request is no longer pending');
    }
    if (new Date() > adj.expiresAt) {
      throw new BadRequestException('Adjustment request has expired');
    }

    const newStatus = approve ? 'APPROVED' : 'REJECTED';

    const [updated] = await this.prisma.$transaction([
      this.prisma.materialsAdjustmentRequest.update({
        where: { id: adjustmentId },
        data: {
          status: newStatus as any,
          respondedAt: new Date(),
          respondedById: customerId,
        },
      }),
      // If approved, increase paidAmount (in practice this triggers a new charge)
      ...(approve
        ? [
            this.prisma.materialsPayment.update({
              where: { id: adj.materialsPaymentId },
              data: {
                paidAmount: {
                  increment: Number(adj.requestedAdditionalAmount),
                },
              },
            }),
          ]
        : []),
    ]);

    this.events.emit('materials.adjustment.responded', {
      adjustmentId,
      approved: approve,
      requestId: adj.materialsPayment.requestId,
    });

    return updated;
  }

  // ── Admin reviews a logged usage entry ────────────────────────────────────
  async reviewUsageLog(adminId: string, usageLogId: string, approve: boolean, notes?: string) {
    const log = await this.prisma.materialsUsageLog.findUnique({ where: { id: usageLogId } });
    if (!log) throw new NotFoundException('Usage log not found');

    const newStatus = approve ? 'APPROVED' : 'REJECTED';

    const updated = await this.prisma.materialsUsageLog.update({
      where: { id: usageLogId },
      data: {
        reviewStatus: newStatus as any,
        reviewedById: adminId,
        reviewedAt: new Date(),
        reviewNotes: notes,
      },
    });

    // If rejected, reverse the deducted amount
    if (!approve) {
      await this.prisma.materialsPayment.update({
        where: { id: log.materialsPaymentId },
        data: { usedAmount: { decrement: Number(log.amount) } },
      });
      this.events.emit('materials.usage.rejected', { usageLogId, amount: log.amount });
    }

    return updated;
  }

  // ── Final reconciliation — refund any unused materials balance ────────────
  async reconcile(requestId: string, initiatedBy: string) {
    const mp = await this.prisma.materialsPayment.findUnique({ where: { requestId } });
    if (!mp) throw new NotFoundException('Materials payment not found');

    if (
      (
        [
          MaterialsPaymentStatus.REFUNDED_FULL,
          MaterialsPaymentStatus.REFUNDED_PARTIAL,
          MaterialsPaymentStatus.FULLY_USED,
        ] as MaterialsPaymentStatus[]
      ).includes(mp.status)
    ) {
      throw new BadRequestException('Materials payment already reconciled');
    }

    const unused = Number(mp.paidAmount) - Number(mp.usedAmount) - Number(mp.refundedAmount);

    let newStatus: MaterialsPaymentStatus;
    if (unused <= 0) {
      newStatus = MaterialsPaymentStatus.FULLY_USED;
    } else if (Number(mp.usedAmount) > 0) {
      newStatus = MaterialsPaymentStatus.REFUNDED_PARTIAL;
    } else {
      newStatus = MaterialsPaymentStatus.REFUNDED_FULL;
    }

    const updated = await this.prisma.materialsPayment.update({
      where: { id: mp.id },
      data: {
        status: newStatus,
        refundedAmount: { increment: unused > 0 ? unused : 0 },
        reconciledAt: new Date(),
      },
    });

    if (unused > 0) {
      this.events.emit('materials.reconciled.refund', {
        requestId,
        refundAmount: unused,
        initiatedBy,
      });
    }

    this.logger.log(
      `Materials reconciled for request ${requestId}: used=${mp.usedAmount}, refund=${unused.toFixed(2)} SAR`,
    );

    return { ...updated, refundTriggered: unused > 0, refundAmount: +unused.toFixed(2) };
  }

  // ── Full refund (order cancelled before any purchase) ────────────────────
  async fullRefund(requestId: string) {
    const mp = await this.prisma.materialsPayment.findUnique({ where: { requestId } });
    if (!mp) return null; // service-only order — nothing to do

    if (Number(mp.usedAmount) > 0) {
      throw new BadRequestException(
        'Cannot issue full materials refund: purchases already logged. Use reconcile() instead.',
      );
    }

    const updated = await this.prisma.materialsPayment.update({
      where: { id: mp.id },
      data: {
        status: MaterialsPaymentStatus.REFUNDED_FULL,
        refundedAmount: mp.paidAmount,
        reconciledAt: new Date(),
      },
    });

    this.events.emit('materials.refund.full', { requestId, amount: mp.paidAmount });
    return updated;
  }

  // ── Freeze during dispute ─────────────────────────────────────────────────
  async freeze(requestId: string) {
    return this.prisma.materialsPayment.updateMany({
      where: {
        requestId,
        status: {
          notIn: [MaterialsPaymentStatus.REFUNDED_FULL, MaterialsPaymentStatus.REFUNDED_PARTIAL],
        },
      },
      data: { status: MaterialsPaymentStatus.FROZEN },
    });
  }

  // ── Unfreeze when dispute resolved ───────────────────────────────────────
  async unfreeze(requestId: string) {
    const mp = await this.prisma.materialsPayment.findUnique({ where: { requestId } });
    if (!mp || mp.status !== MaterialsPaymentStatus.FROZEN) return;

    const usedAmount = Number(mp.usedAmount);
    const paidAmount = Number(mp.paidAmount);
    const restoreStatus: MaterialsPaymentStatus =
      usedAmount === 0
        ? MaterialsPaymentStatus.PAID_AVAILABLE
        : usedAmount >= paidAmount
          ? MaterialsPaymentStatus.FULLY_USED
          : MaterialsPaymentStatus.PARTIALLY_USED;

    return this.prisma.materialsPayment.update({
      where: { id: mp.id },
      data: { status: restoreStatus },
    });
  }

  // ── Admin list view ───────────────────────────────────────────────────────
  async adminList(status?: MaterialsPaymentStatus) {
    return this.prisma.materialsPayment.findMany({
      where: status ? { status } : {},
      include: {
        request: {
          select: {
            id: true,
            customer: { select: { id: true, profile: { select: { nameAr: true, nameEn: true } } } },
            provider: { select: { id: true, profile: { select: { nameAr: true, nameEn: true } } } },
            service: { select: { nameAr: true } },
          },
        },
        _count: { select: { usageLogs: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  // ── Private helpers ───────────────────────────────────────────────────────
  private async _getAndValidateForProvider(providerId: string, requestId: string) {
    const mp = await this.prisma.materialsPayment.findUnique({ where: { requestId } });
    if (!mp) throw new NotFoundException('Materials payment not found for this order');

    const request = await this.prisma.serviceRequest.findUnique({
      where: { id: requestId },
      select: { providerId: true },
    });
    if (request?.providerId !== providerId) {
      throw new ForbiddenException(
        'Only the assigned provider can manage materials for this order',
      );
    }

    if (
      (
        [
          MaterialsPaymentStatus.FROZEN,
          MaterialsPaymentStatus.REFUNDED_FULL,
          MaterialsPaymentStatus.REFUNDED_PARTIAL,
          MaterialsPaymentStatus.FULLY_USED,
        ] as MaterialsPaymentStatus[]
      ).includes(mp.status)
    ) {
      throw new BadRequestException(
        `Materials budget is ${mp.status.toLowerCase()} — no further actions allowed`,
      );
    }

    return mp;
  }
}
