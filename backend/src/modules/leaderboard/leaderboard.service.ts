import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Logger } from '@nestjs/common';
import { ProviderVerificationStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

// ── Badge definitions ────────────────────────────────────────────────────────
const BADGES = [
  { key: 'FIRST_JOB', labelAr: 'أول خدمة', icon: '🎉', condition: (j: number) => j >= 1 },
  { key: 'TEN_JOBS', labelAr: '١٠ خدمات', icon: '⭐', condition: (j: number) => j >= 10 },
  { key: 'FIFTY_JOBS', labelAr: '٥٠ خدمة', icon: '🏅', condition: (j: number) => j >= 50 },
  { key: 'HUNDRED_JOBS', labelAr: '١٠٠ خدمة', icon: '🏆', condition: (j: number) => j >= 100 },
  {
    key: 'TOP_RATED',
    labelAr: 'الأعلى تقييمًا',
    icon: '💎',
    condition: (_j: number, r?: number) => (r ?? 0) >= 4.8,
  },
  {
    key: 'SUPER_PROVIDER',
    labelAr: 'مزود مميز',
    icon: '🦸',
    condition: (j: number, r?: number) => j >= 50 && (r ?? 0) >= 4.7,
  },
] as const;

@Injectable()
export class LeaderboardService {
  private readonly logger = new Logger(LeaderboardService.name);

  constructor(private prisma: PrismaService) {}

  // ── Top providers leaderboard ──────────────────────────────────────────────
  async getLeaderboard(category: 'OVERALL' | 'WEEKLY' | 'MONTHLY' = 'OVERALL', limit = 20) {
    const since = this._sinceDate(category);
    const where: any = {
      verificationStatus: ProviderVerificationStatus.APPROVED,
      user: { deletedAt: null, suspended: false, status: 'ACTIVE' },
    };

    if (since) {
      // Filter by recently active providers
      where.user = {
        ...where.user,
        requestsAsProvider: {
          some: { completedAt: { gte: since }, status: 'COMPLETED' },
        },
      };
    }

    const providers = await this.prisma.providerProfile.findMany({
      where,
      orderBy: [{ ratingAvg: 'desc' }, { completedJobs: 'desc' }],
      take: limit,
      include: {
        user: { include: { profile: true } },
      },
    });

    return providers.map((p, i) => ({
      rank: i + 1,
      providerId: p.id,
      name: p.user.profile?.nameAr ?? p.user.profile?.nameEn ?? null,
      avatar: p.user.profile?.avatarUrl,
      rating: p.ratingAvg,
      completedJobs: p.completedJobs,
      badges: this._computeBadges(p.completedJobs, Number(p.ratingAvg)),
    }));
  }

  // ── My badges ─────────────────────────────────────────────────────────────
  async getMyBadges(userId: string) {
    const profile = await this.prisma.providerProfile.findUnique({
      where: { userId },
      select: { completedJobs: true, ratingAvg: true },
    });
    if (!profile) return [];
    return this._computeBadges(profile.completedJobs, Number(profile.ratingAvg));
  }

  // ── Provider stats card (for profile page) ────────────────────────────────
  async getProviderStats(providerId: string) {
    // First resolve the userId — serviceRequest.providerId stores the User.id,
    // but this endpoint receives the ProviderProfile.id (used in public URLs).
    const profile = await this.prisma.providerProfile.findUnique({
      where: { id: providerId },
      select: { completedJobs: true, ratingAvg: true, createdAt: true, userId: true },
    });

    const userId = profile?.userId ?? providerId; // fall back if not found

    const [monthlyJobs, repeatCustomers] = await Promise.all([
      this.prisma.serviceRequest.count({
        where: {
          providerId: userId,
          status: 'COMPLETED',
          completedAt: { gte: new Date(new Date().setDate(1)) }, // this month
        },
      }),
      this.prisma.$queryRaw<any[]>`
        SELECT COUNT(DISTINCT customer_id) as repeat_customers
        FROM (
          SELECT customer_id, COUNT(*) as job_count
          FROM service_requests
          WHERE provider_id = ${userId} AND status = 'COMPLETED'
          GROUP BY customer_id HAVING COUNT(*) > 1
        ) t
      `,
    ]);

    return {
      completedJobs: profile?.completedJobs ?? 0,
      rating: profile?.ratingAvg ?? 0,
      jobsThisMonth: monthlyJobs,
      repeatCustomers: Number(repeatCustomers[0]?.repeat_customers ?? 0),
      badges: this._computeBadges(profile?.completedJobs ?? 0, Number(profile?.ratingAvg ?? 0)),
      memberSince: profile?.createdAt,
    };
  }

  // ── Weekly leaderboard refresh cron (every Sunday midnight) ───────────────
  @Cron('0 0 * * SUN')
  async refreshLeaderboardCache() {
    this.logger.log('Refreshing leaderboard cache…');
    // In production this would write to Redis for instant reads
    // For now it's a no-op hook for future caching layer
  }

  // ── Private helpers ────────────────────────────────────────────────────────
  private _computeBadges(jobs: number, rating: number) {
    return BADGES.filter((b) => b.condition(jobs, rating)).map(({ key, labelAr, icon }) => ({
      key,
      labelAr,
      icon,
    }));
  }

  private _sinceDate(category: string): Date | null {
    const now = new Date();
    if (category === 'WEEKLY') return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    if (category === 'MONTHLY') return new Date(now.getFullYear(), now.getMonth(), 1);
    return null;
  }
}
