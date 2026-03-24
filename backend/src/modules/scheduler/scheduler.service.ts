import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { MaterialsPaymentService } from '../materials-payment/materials-payment.service';
import { QuoteStatus, RentalStatus, DisputeStatus, MaterialsPaymentStatus, JobStatus } from '@prisma/client';
import * as Sentry from '@sentry/node';

@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);

  constructor(
    private prisma: PrismaService,
    private events: EventEmitter2,
    private materials: MaterialsPaymentService,
  ) {}

  /** Every hour: auto-release escrow older than 48h after completion */
  @Cron(CronExpression.EVERY_HOUR)
  async autoReleaseEscrow() {
    const start = Date.now();
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);

    const held = await this.prisma.escrow.findMany({
      where: {
        status: 'HELD',
        request: {
          status: 'COMPLETED',
          completedAt: { lte: cutoff },
          // Do not auto-release while a dispute is open or under review
          disputes: { none: { status: { in: [DisputeStatus.OPEN, DisputeStatus.UNDER_REVIEW] } } },
        },
      },
      include: { request: true },
    });

    let released = 0;
    for (const escrow of held) {
      // Atomic claim: only the instance that transitions status HELD → RELEASED
      // emits the event. If another cron instance already released it, count = 0
      // and we skip — preventing double wallet credits on concurrent runs.
      const { count } = await this.prisma.escrow.updateMany({
        where: { id: escrow.id, status: 'HELD' },
        data: { status: 'RELEASED', releasedAt: new Date() },
      });
      if (count === 0) continue;

      this.events.emit('escrow.released', {
        escrowId: escrow.id,
        requestId: escrow.requestId,
        providerId: escrow.request.providerId,
      });
      released++;
    }

    await this.logJob(
      'auto_release_escrow',
      JobStatus.SUCCESS,
      `Released ${released} escrows`,
      Date.now() - start,
    );
    if (released > 0) this.logger.log(`Auto-released ${released} escrows`);
  }

  /** Every day at 8am: mark overdue commissions */
  @Cron('0 8 * * *', { timeZone: 'Asia/Riyadh' })
  async markOverdueCommissions() {
    const start = Date.now();
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days

    const { count } = await this.prisma.tenderCommission.updateMany({
      where: {
        status: 'INVOICE_ISSUED',
        invoiceIssuedAt: { lte: cutoff },
      },
      data: { status: 'OVERDUE', overdueAt: new Date() },
    });

    await this.logJob(
      'mark_overdue_commissions',
      JobStatus.SUCCESS,
      `Marked ${count} commissions overdue`,
      Date.now() - start,
    );
    if (count > 0) {
      this.logger.warn(`Marked ${count} commissions as overdue`);
      this.events.emit('commissions.overdue_batch', { count });
    }
  }

  /** Every day at midnight: deactivate device tokens not seen for 90 days */
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async cleanupStaleDeviceTokens() {
    const start = Date.now();
    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

    // Tokens not seen for 90 days (by last update) are likely uninstalled apps — deactivate them
    const { count } = await this.prisma.deviceToken.updateMany({
      where: { active: true, updatedAt: { lte: cutoff } } as any,
      data: { active: false },
    });

    await this.logJob(
      'cleanup_stale_device_tokens',
      JobStatus.SUCCESS,
      `Deactivated ${count} stale device tokens`,
      Date.now() - start,
    );
  }

  /** Every week: delete expired refresh tokens + auth tokens */
  @Cron(CronExpression.EVERY_WEEK)
  async cleanupRefreshTokens() {
    const start = Date.now();
    const now = new Date();

    const [rtCount, evtCount, prtCount] = await Promise.all([
      this.prisma.refreshToken
        .deleteMany({ where: { expiresAt: { lte: now } } })
        .then((r) => r.count),
      this.prisma.emailVerificationToken
        .deleteMany({ where: { expiresAt: { lte: now } } })
        .then((r) => r.count),
      this.prisma.passwordResetToken
        .deleteMany({ where: { expiresAt: { lte: now } } })
        .then((r) => r.count),
    ]);

    await this.logJob(
      'cleanup_auth_tokens',
      JobStatus.SUCCESS,
      `Deleted ${rtCount} refresh, ${evtCount} email-verify, ${prtCount} password-reset tokens`,
      Date.now() - start,
    );
  }

  /** Every day: update provider rating averages */
  @Cron('0 3 * * *', { timeZone: 'Asia/Riyadh' })
  async recalcProviderRatings() {
    const start = Date.now();

    const grouped = await this.prisma.review.groupBy({
      by: ['rateeId'],
      _avg: { score: true },
      _count: { score: true },
      having: { score: { _count: { gt: 0 } } },
    });

    let updated = 0;
    for (const g of grouped) {
      const avg = parseFloat((g._avg.score ?? 0).toFixed(2));
      const cnt = g._count.score;
      const res = await this.prisma.providerProfile.updateMany({
        where: { userId: g.rateeId },
        data: { ratingAvg: avg, ratingCount: cnt },
      });
      if (res.count > 0) updated++;
    }

    await this.logJob('recalc_provider_ratings', JobStatus.SUCCESS, `Updated ${updated} providers`, Date.now() - start);
  }

  // ── NEW: Auto-reconcile completed orders with materials ─────────────────────
  /**
   * Every 2 hours: find COMPLETED orders with unconcluded MaterialsPayment
   * and trigger reconciliation (refund unused materials budget).
   * Only acts on orders completed > 2 hours ago to give providers time to
   * upload final receipts.
   */
  @Cron('0 */2 * * *')
  async autoReconcileMaterials() {
    const start = Date.now();
    const cutoff = new Date(Date.now() - 2 * 60 * 60 * 1000);

    const pending = await this.prisma.materialsPayment.findMany({
      where: {
        status: { in: [MaterialsPaymentStatus.PAID_AVAILABLE, MaterialsPaymentStatus.PARTIALLY_USED] },
        request: { status: 'COMPLETED', completedAt: { lte: cutoff } },
      },
      select: { requestId: true },
    });

    let reconciled = 0;
    let errors = 0;

    for (const mp of pending) {
      try {
        await this.materials.reconcile(mp.requestId, 'system');
        reconciled++;
      } catch (err) {
        errors++;
        this.logger.error(`autoReconcileMaterials failed for request ${mp.requestId}: ${err}`);
      }
    }

    await this.logJob(
      'auto_reconcile_materials',
      errors > 0 ? JobStatus.FAILED : JobStatus.SUCCESS,
      `Reconciled ${reconciled} materials payments (${errors} errors)`,
      Date.now() - start,
    );

    if (reconciled > 0) {
      this.logger.log(`Auto-reconciled ${reconciled} materials payments`);
    }
  }

  // ── NEW: Expire stale adjustment requests ────────────────────────────────
  /**
   * Every 30 minutes: expire MaterialsAdjustmentRequests where
   * expiresAt < NOW() and status is still PENDING.
   * Prevents provider from blocking indefinitely on an unanswered request.
   */
  @Cron('*/30 * * * *')
  async expireAdjustmentRequests() {
    const start = Date.now();

    const { count } = await this.prisma.materialsAdjustmentRequest.updateMany({
      where: {
        status: 'PENDING',
        expiresAt: { lte: new Date() },
      },
      data: { status: 'EXPIRED' },
    });

    await this.logJob(
      'expire_adjustment_requests',
      JobStatus.SUCCESS,
      `Expired ${count} adjustment requests`,
      Date.now() - start,
    );

    if (count > 0) {
      this.logger.log(`Expired ${count} materials adjustment requests`);
      this.events.emit('materials.adjustment.batch_expired', { count });
    }
  }

  // ── NEW: Auto-release escrow for READY_FOR_RELEASE status ───────────────
  /**
   * Every 15 minutes: check for escrows with status READY_FOR_RELEASE
   * (manually queued by admin or dispute resolution) and finalize them.
   */
  @Cron('*/15 * * * *')
  async processReadyEscrows() {
    const start = Date.now();

    const ready = await this.prisma.escrow.findMany({
      where: { status: 'READY_FOR_RELEASE' },
      include: { request: { select: { providerId: true } } },
    });

    let processed = 0;
    for (const escrow of ready) {
      const { count } = await this.prisma.escrow.updateMany({
        where: { id: escrow.id, status: 'READY_FOR_RELEASE' },
        data: { status: 'RELEASED', releasedAt: new Date() },
      });
      if (count === 0) continue;

      this.events.emit('escrow.released', {
        escrowId: escrow.id,
        requestId: escrow.requestId,
        providerId: escrow.request.providerId,
        source: 'scheduler',
      });

      processed++;
    }

    await this.logJob(
      'process_ready_escrows',
      JobStatus.SUCCESS,
      `Processed ${processed} ready-for-release escrows`,
      Date.now() - start,
    );
  }

  /** Every 2 hours: auto-cancel PENDING equipment rentals older than 24h */
  @Cron('0 */2 * * *')
  async cancelStalePendingRentals() {
    const start = Date.now();
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);

    // Fetch PENDING rentals older than 24h to get their equipment IDs
    const staleRentals = await this.prisma.equipmentRental.findMany({
      where: {
        status: 'PENDING',
        createdAt: { lte: cutoff },
      },
      select: { id: true, equipmentId: true },
    });

    if (staleRentals.length === 0) {
      await this.logJob('cancel_stale_pending_rentals', JobStatus.SUCCESS, 'No stale rentals found', Date.now() - start);
      return;
    }

    const rentalIds = staleRentals.map((r) => r.id);
    const equipmentIds = [...new Set(staleRentals.map((r) => r.equipmentId))];

    const [cancelResult] = await this.prisma.$transaction([
      this.prisma.equipmentRental.updateMany({
        where: { id: { in: rentalIds }, status: RentalStatus.PENDING },
        data: { status: RentalStatus.CANCELLED, cancelledAt: new Date() },
      }),
      this.prisma.equipment.updateMany({
        where: { id: { in: equipmentIds } },
        data: { isAvailable: true },
      }),
    ]);

    await this.logJob(
      'cancel_stale_pending_rentals',
      JobStatus.SUCCESS,
      `Cancelled ${cancelResult.count} stale PENDING rentals; restored ${equipmentIds.length} equipment items`,
      Date.now() - start,
    );

    if (cancelResult.count > 0) {
      this.logger.log(`Auto-cancelled ${cancelResult.count} stale PENDING equipment rentals`);
    }
  }

  /** Every hour: reject quotes whose expiresAt has passed and are still PENDING */
  @Cron(CronExpression.EVERY_HOUR)
  async expireStaleQuotes() {
    const start = Date.now();
    const result = await this.prisma.quote.updateMany({
      where: {
        status: QuoteStatus.PENDING,
        expiresAt: { lt: new Date() },
      },
      data: { status: QuoteStatus.EXPIRED },
    });
    await this.logJob(
      'expire_stale_quotes',
      JobStatus.SUCCESS,
      `Expired ${result.count} stale quotes`,
      Date.now() - start,
    );
  }

  private async logJob(
    jobName: string,
    status: JobStatus,
    message: string,
    duration: number,
  ) {
    await this.prisma.scheduledJobLog
      .create({
        data: { jobName, status, message, duration },
      })
      .catch((err) => { this.logger.warn(`Failed to write job log for ${jobName}: ${err?.message}`); });

    if (status === JobStatus.FAILED) {
      Sentry.captureMessage(`Cron job failed: ${jobName} — ${message}`, 'error');
    }
  }
}
