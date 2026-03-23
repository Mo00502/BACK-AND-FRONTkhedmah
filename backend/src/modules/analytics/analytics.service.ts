import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class AnalyticsService {
  constructor(private prisma: PrismaService) {}

  // ── Platform-wide overview ──────────────────────────────────────────────
  async getPlatformOverview() {
    const [
      users,
      providers,
      requests,
      homeServicesRevenue,
      tenderCommissions,
      equipmentFees,
      topServices,
      topCities,
    ] = await Promise.all([
      this.prisma.user.count({ where: { deletedAt: null } }),
      this.prisma.providerProfile.count({ where: { verificationStatus: 'APPROVED' } }),
      this.prisma.serviceRequest.count({ where: { status: 'COMPLETED' } }),

      // Home Services vertical (15% platform fee)
      this.prisma.escrow.aggregate({
        where: { status: 'RELEASED' },
        _sum: { amount: true, platformFee: true },
      }),

      // Tender vertical (2% commission)
      this.prisma.tenderCommission.aggregate({
        where: { status: 'PAID' as any },
        _sum: { commissionAmount: true },
      }),

      // Equipment vertical (10% fee on rentals)
      this.prisma.equipmentRental.aggregate({
        where: { status: 'COMPLETED' },
        _sum: { totalPrice: true },
      }),

      this.prisma.serviceRequest.groupBy({
        by: ['serviceId'],
        _count: { id: true },
        orderBy: { _count: { id: 'desc' } },
        take: 5,
      }),

      this.prisma.serviceRequest.groupBy({
        by: ['city'],
        _count: { id: true },
        orderBy: { _count: { id: 'desc' } },
        take: 5,
      }),
    ]);

    const homeGMV = Number(homeServicesRevenue._sum.amount || 0);
    const homeFees = Number(homeServicesRevenue._sum.platformFee || 0);
    const tenderFees = Number(tenderCommissions._sum.commissionAmount || 0);
    const equipmentGMV = Number(equipmentFees._sum.totalPrice || 0);
    const equipmentFeeEst = equipmentGMV * 0.1;

    return {
      totalUsers: users,
      verifiedProviders: providers,
      completedRequests: requests,
      revenue: {
        homeServices: { gmv: homeGMV, fees: homeFees },
        tenders: { commissions: tenderFees },
        equipment: { gmv: equipmentGMV, feeEstimate: equipmentFeeEst },
        totalPlatformRevenue: homeFees + tenderFees + equipmentFeeEst,
      },
      topServices,
      topCities,
    };
  }

  // ── Monthly trends (12 months) ──────────────────────────────────────────
  async getMonthlyTrends(months = 12) {
    const since = new Date();
    since.setMonth(since.getMonth() - months);

    const [requestTrend, revenueTrend, userGrowth, tenderTrend] = await Promise.all([
      this.prisma.$queryRaw<any[]>`
        SELECT
          TO_CHAR(DATE_TRUNC('month', created_at), 'YYYY-MM') AS month,
          COUNT(*)                                             AS total,
          COUNT(CASE WHEN status = 'COMPLETED' THEN 1 END)   AS completed,
          COUNT(CASE WHEN status = 'CANCELLED' THEN 1 END)   AS cancelled
        FROM service_requests
        WHERE created_at >= ${since}
        GROUP BY DATE_TRUNC('month', created_at)
        ORDER BY month ASC
      `,
      this.prisma.$queryRaw<any[]>`
        SELECT
          TO_CHAR(DATE_TRUNC('month', held_at), 'YYYY-MM') AS month,
          SUM(platform_fee)                                 AS platform_fee,
          SUM(amount)                                       AS gmv
        FROM escrow
        WHERE status = 'RELEASED' AND held_at >= ${since}
        GROUP BY DATE_TRUNC('month', held_at)
        ORDER BY month ASC
      `,
      this.prisma.$queryRaw<any[]>`
        SELECT
          TO_CHAR(DATE_TRUNC('month', created_at), 'YYYY-MM') AS month,
          COUNT(*)                                             AS new_users
        FROM users
        WHERE created_at >= ${since} AND deleted_at IS NULL
        GROUP BY DATE_TRUNC('month', created_at)
        ORDER BY month ASC
      `,
      this.prisma.$queryRaw<any[]>`
        SELECT
          TO_CHAR(DATE_TRUNC('month', created_at), 'YYYY-MM') AS month,
          COUNT(*)                                             AS tenders,
          SUM(COALESCE(budget_min, 0))                        AS budget
        FROM tenders
        WHERE created_at >= ${since}
        GROUP BY DATE_TRUNC('month', created_at)
        ORDER BY month ASC
      `,
    ]);

    return { requestTrend, revenueTrend, userGrowth, tenderTrend };
  }

  // ── Provider performance leaderboard ───────────────────────────────────
  async getTopProviders(limit = 10) {
    return this.prisma.providerProfile.findMany({
      where: { verificationStatus: 'APPROVED', user: { status: 'ACTIVE', suspended: false } },
      orderBy: [{ completedJobs: 'desc' }, { ratingAvg: 'desc' }],
      take: limit,
      include: {
        user: { include: { profile: true } },
        skills: { select: { serviceId: true } },
      },
    });
  }

  // ── Equipment utilization ───────────────────────────────────────────────
  async getEquipmentStats() {
    const [total, byCategory, topRented] = await Promise.all([
      this.prisma.equipment.count({ where: { status: 'ACTIVE' } }),
      this.prisma.equipment.groupBy({
        by: ['category'],
        _count: { id: true },
        orderBy: { _count: { id: 'desc' } },
      }),
      this.prisma.equipment.findMany({
        where: { status: 'ACTIVE' },
        orderBy: { rentalCount: 'desc' },
        take: 10,
        select: { id: true, name: true, category: true, rentalCount: true, rating: true },
      }),
    ]);

    return { activeListings: total, byCategory, topRented };
  }

  // ── Tender ecosystem metrics ────────────────────────────────────────────
  async getTenderStats() {
    const [byStatus, avgBidsPerTender, commissionsByMonth] = await Promise.all([
      this.prisma.tender.groupBy({
        by: ['status'],
        _count: { id: true },
        _sum: { budgetMin: true },
      }),
      this.prisma.$queryRaw<any[]>`
        SELECT AVG(bid_count) AS avg_bids_per_tender
        FROM (
          SELECT tender_id, COUNT(*) AS bid_count
          FROM tender_bids
          GROUP BY tender_id
        ) sub
      `,
      this.prisma.$queryRaw<any[]>`
        SELECT
          TO_CHAR(DATE_TRUNC('month', created_at), 'YYYY-MM') AS month,
          SUM(commission_amount)                               AS commissions
        FROM tender_commissions
        WHERE status IN ('PAID')
        GROUP BY DATE_TRUNC('month', created_at)
        ORDER BY month ASC
        LIMIT 12
      `,
    ]);

    return {
      byStatus,
      avgBidsPerTender: avgBidsPerTender[0]?.avg_bids_per_tender || 0,
      commissionsByMonth,
    };
  }

  // ── Conversion funnel (request → quote → payment → completion) ─────────
  async getConversionFunnel() {
    const [created, quoted, paid, completed] = await Promise.all([
      this.prisma.serviceRequest.count(),
      this.prisma.serviceRequest.count({
        where: { status: { in: ['ACCEPTED', 'IN_PROGRESS', 'COMPLETED'] } },
      }),
      this.prisma.serviceRequest.count({ where: { status: { in: ['IN_PROGRESS', 'COMPLETED'] } } }),
      this.prisma.serviceRequest.count({ where: { status: 'COMPLETED' } }),
    ]);

    return {
      created,
      quoted,
      paid,
      completed,
      quotedRate: created ? Math.round((quoted / created) * 100) : 0,
      paidRate: quoted ? Math.round((paid / quoted) * 100) : 0,
      completionRate: paid ? Math.round((completed / paid) * 100) : 0,
    };
  }

  // ── Consultation metrics ─────────────────────────────────────────────────
  async getConsultationStats() {
    const [byStatus, byMode, avgRating, recentTrend] = await Promise.all([
      // Volume by status
      this.prisma.consultation.groupBy({
        by: ['status'],
        _count: { id: true },
      }),

      // Preferred mode (chat/voice/video)
      this.prisma.consultation.groupBy({
        by: ['mode'],
        _count: { id: true },
        orderBy: { _count: { id: 'desc' } },
      }),

      // Average customer rating on completed sessions
      this.prisma.consultation.aggregate({
        where: { status: 'COMPLETED', rating: { not: null } },
        _avg: { rating: true },
        _count: { rating: true },
      }),

      // Last 12 months trend
      this.prisma.$queryRaw<any[]>`
        SELECT
          TO_CHAR(DATE_TRUNC('month', created_at), 'YYYY-MM') AS month,
          COUNT(*)                                             AS total,
          COUNT(CASE WHEN status = 'COMPLETED' THEN 1 END)   AS completed,
          COUNT(CASE WHEN status = 'CANCELLED' OR status = 'REJECTED' THEN 1 END) AS cancelled
        FROM consultations
        WHERE created_at >= NOW() - INTERVAL '12 months'
        GROUP BY DATE_TRUNC('month', created_at)
        ORDER BY month ASC
      `,
    ]);

    const total = byStatus.reduce((s, r) => s + r._count.id, 0);
    const completed = byStatus.find((r) => r.status === 'COMPLETED')?._count.id ?? 0;
    const inSession = byStatus.find((r) => r.status === 'IN_SESSION')?._count.id ?? 0;

    return {
      total,
      byStatus,
      byMode,
      completionRate: total ? Math.round((completed / total) * 100) : 0,
      activeNow: inSession,
      avgRating: avgRating._avg.rating ? Number(avgRating._avg.rating).toFixed(2) : null,
      ratedCount: avgRating._count.rating,
      monthlyTrend: recentTrend,
    };
  }
}
