import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../prisma/prisma.service';
import { UpdateProviderDto, AddSkillDto, SetAvailabilityDto } from './dto/update-provider.dto';
import { PaginationDto, paginate } from '../../common/dto/pagination.dto';
import { Prisma } from '@prisma/client';

const HOME_SERVICES_COMMISSION = 0.15; // 15%

@Injectable()
export class ProvidersService {
  constructor(
    private prisma: PrismaService,
    private events: EventEmitter2,
  ) {}

  async findAll(dto: PaginationDto & { serviceId?: string; city?: string }) {
    const where: any = {
      // Only surface APPROVED providers to customers — never pending/rejected/suspended
      verificationStatus: 'APPROVED',
      user: { status: 'ACTIVE', deletedAt: null, suspended: false },
    };

    if (dto.serviceId) {
      where.skills = { some: { serviceId: dto.serviceId } };
    }

    if (dto.city) {
      where.user = { ...where.user, profile: { city: dto.city } };
    }

    const [providers, total] = await Promise.all([
      this.prisma.providerProfile.findMany({
        where,
        include: {
          user: { include: { profile: true } },
          skills: { include: { service: true } },
          availability: true,
        },
        skip: dto.skip,
        take: dto.limit,
        orderBy: { ratingAvg: 'desc' },
      }),
      this.prisma.providerProfile.count({ where }),
    ]);

    return paginate(providers, total, dto);
  }

  async findByUserId(userId: string) {
    const profile = await this.prisma.providerProfile.findFirst({
      where: {
        userId,
        verificationStatus: 'APPROVED' as any,
        user: { deletedAt: null, suspended: false, status: 'ACTIVE' as any },
      },
      include: {
        user: { include: { profile: true } },
        skills: { include: { service: true } },
        availability: true,
      },
    });
    if (!profile) throw new NotFoundException('Provider profile not found');
    return profile;
  }

  async upsertProfile(userId: string, dto: UpdateProviderDto) {
    // Explicitly allowlist safe fields — never allow verificationStatus, verified,
    // ratingAvg, ratingCount, completedJobs, suspendedAt, suspensionReason to be
    // set directly by the provider.
    const safeUpdate: Partial<Pick<UpdateProviderDto, 'yearsExperience' | 'crNumber' | 'ibanNumber' | 'bankName'>> = {};
    if (dto.yearsExperience !== undefined) safeUpdate.yearsExperience = dto.yearsExperience;
    if (dto.crNumber !== undefined) safeUpdate.crNumber = dto.crNumber;
    if (dto.ibanNumber !== undefined) safeUpdate.ibanNumber = dto.ibanNumber;
    if (dto.bankName !== undefined) safeUpdate.bankName = dto.bankName;

    return this.prisma.providerProfile.upsert({
      where: { userId },
      update: safeUpdate,
      create: { userId, ...safeUpdate },
      include: { skills: true, availability: true },
    });
  }

  async addSkill(userId: string, dto: AddSkillDto) {
    if (dto.hourlyRate !== undefined && dto.hourlyRate <= 0) {
      throw new BadRequestException('يجب أن يكون السعر بالساعة أكبر من صفر');
    }

    const profile = await this.prisma.providerProfile.findUnique({ where: { userId } });
    if (!profile) throw new NotFoundException('Provider profile not found. Create it first.');

    const existing = await this.prisma.providerSkill.findUnique({
      where: { providerId_serviceId: { providerId: profile.id, serviceId: dto.serviceId } },
    });
    if (existing) throw new ConflictException('Skill already added');

    return this.prisma.providerSkill.create({
      data: { providerId: profile.id, serviceId: dto.serviceId, hourlyRate: dto.hourlyRate },
      include: { service: true },
    });
  }

  async removeSkill(userId: string, skillId: string) {
    const profile = await this.prisma.providerProfile.findUnique({ where: { userId } });
    if (!profile) throw new NotFoundException('Provider profile not found');

    return this.prisma.providerSkill.deleteMany({
      where: { id: skillId, providerId: profile.id },
    });
  }

  async updateSkill(userId: string, skillId: string, dto: { hourlyRate?: number }) {
    if (dto.hourlyRate !== undefined && dto.hourlyRate <= 0) {
      throw new BadRequestException('يجب أن يكون السعر بالساعة أكبر من صفر');
    }
    const profile = await this.prisma.providerProfile.findUnique({ where: { userId } });
    if (!profile) throw new NotFoundException('Provider profile not found');

    const skill = await this.prisma.providerSkill.findFirst({
      where: { id: skillId, providerId: profile.id },
    });
    if (!skill) throw new NotFoundException('Skill not found');

    return this.prisma.providerSkill.update({
      where: { id: skillId },
      data: {
        ...(dto.hourlyRate !== undefined && { hourlyRate: dto.hourlyRate }),
      },
    });
  }

  async setAvailability(userId: string, dto: SetAvailabilityDto) {
    const profile = await this.prisma.providerProfile.findUnique({ where: { userId } });
    if (!profile) throw new NotFoundException('Provider profile not found');

    await this.prisma.providerAvailability.deleteMany({ where: { providerId: profile.id } });

    const created = await this.prisma.providerAvailability.createMany({
      data: dto.slots.map((s) => ({ providerId: profile.id, ...s })),
    });

    return created;
  }

  async getEarnings(userId: string) {
    const profile = await this.prisma.providerProfile.findUnique({ where: { userId } });
    if (!profile) throw new NotFoundException('Provider profile not found');

    const [available, pending, total] = await Promise.all([
      this.prisma.escrow.aggregate({
        where: { request: { providerId: userId }, status: 'RELEASED' },
        _sum: { amount: true },
      }),
      this.prisma.escrow.aggregate({
        where: { request: { providerId: userId }, status: 'HELD' },
        _sum: { amount: true },
      }),
      this.prisma.escrow.aggregate({
        where: { request: { providerId: userId }, status: { in: ['RELEASED', 'HELD'] } },
        _sum: { amount: true },
      }),
    ]);

    const PLATFORM_FEE_RATE = 0.15;
    const grossAvailable = Number(available._sum.amount ?? 0);
    const grossPending = Number(pending._sum.amount ?? 0);
    const gross = Number(total._sum.amount ?? 0);
    return {
      available: parseFloat((grossAvailable * (1 - PLATFORM_FEE_RATE)).toFixed(2)),
      pending: parseFloat((grossPending * (1 - PLATFORM_FEE_RATE)).toFixed(2)),
      gross,
      commission: parseFloat((gross * PLATFORM_FEE_RATE).toFixed(2)),
      net: parseFloat((gross * (1 - PLATFORM_FEE_RATE)).toFixed(2)),
    };
  }

  /**
   * Full earnings dashboard:
   * - Lifetime totals with commission breakdown
   * - Last 8 weeks trend
   * - Last 6 months trend
   * - Last 10 completed jobs with per-job commission
   */
  async getEarningsDashboard(userId: string) {
    const profile = await this.prisma.providerProfile.findUnique({ where: { userId } });
    if (!profile) throw new NotFoundException('Provider profile not found');

    // ── 1. Lifetime totals ─────────────────────────────────────────────────
    const releasedEscrows = await this.prisma.escrow.findMany({
      where: { request: { providerId: userId }, status: 'RELEASED' },
      select: { amount: true },
    });

    const grossLifetime = releasedEscrows.reduce((sum, e) => sum + Number(e.amount), 0);
    const commissionLifetime = +(grossLifetime * HOME_SERVICES_COMMISSION).toFixed(2);
    const netLifetime = +(grossLifetime - commissionLifetime).toFixed(2);

    // ── 2. Weekly trend (last 8 ISO weeks) ────────────────────────────────
    const weeklyRows: Array<{ week: string; gross: string }> = await this.prisma.$queryRaw`
      SELECT
        TO_CHAR(DATE_TRUNC('week', e.released_at), 'IYYY-"W"IW') AS week,
        SUM(e.amount)::numeric                                     AS gross
      FROM escrow e
      JOIN service_requests r ON r.id = e.request_id
      WHERE r.provider_id = ${userId}
        AND e.status = 'RELEASED'
        AND e.released_at >= NOW() - INTERVAL '8 weeks'
      GROUP BY week
      ORDER BY week ASC
    `;

    const weeklyTrend = weeklyRows.map((row) => {
      const gross = +Number(row.gross).toFixed(2);
      const commission = +(gross * HOME_SERVICES_COMMISSION).toFixed(2);
      return { week: row.week, gross, commission, net: +(gross - commission).toFixed(2) };
    });

    // ── 3. Monthly trend (last 6 months) ──────────────────────────────────
    const monthlyRows: Array<{ month: string; gross: string }> = await this.prisma.$queryRaw`
      SELECT
        TO_CHAR(DATE_TRUNC('month', e.released_at), 'YYYY-MM') AS month,
        SUM(e.amount)::numeric                                   AS gross
      FROM escrow e
      JOIN service_requests r ON r.id = e.request_id
      WHERE r.provider_id = ${userId}
        AND e.status = 'RELEASED'
        AND e.released_at >= NOW() - INTERVAL '6 months'
      GROUP BY month
      ORDER BY month ASC
    `;

    const monthlyTrend = monthlyRows.map((row) => {
      const gross = +Number(row.gross).toFixed(2);
      const commission = +(gross * HOME_SERVICES_COMMISSION).toFixed(2);
      return { month: row.month, gross, commission, net: +(gross - commission).toFixed(2) };
    });

    // ── 4. Per-job history (last 10 completed) ────────────────────────────
    const recentJobs = await this.prisma.escrow.findMany({
      where: { request: { providerId: userId }, status: 'RELEASED' },
      orderBy: { releasedAt: 'desc' },
      take: 10,
      select: {
        id: true,
        amount: true,
        releasedAt: true,
        request: {
          select: {
            id: true,
            description: true,
            completedAt: true,
            service: { select: { nameAr: true, nameEn: true } },
            customer: { select: { id: true, profile: { select: { nameAr: true, nameEn: true } } } },
          },
        },
      },
    });

    const jobBreakdown = recentJobs.map((e) => {
      const gross = +Number(e.amount).toFixed(2);
      const commission = +(gross * HOME_SERVICES_COMMISSION).toFixed(2);
      return {
        escrowId: e.id,
        requestId: e.request.id,
        service: e.request.service?.nameAr ?? 'خدمة',
        customerName:
          (e.request.customer as any)?.profile?.nameAr ??
          (e.request.customer as any)?.profile?.nameEn ??
          'عميل',
        completedAt: e.request.completedAt ?? e.releasedAt,
        gross,
        commission,
        net: +(gross - commission).toFixed(2),
      };
    });

    // ── 5. Current period (this calendar month) ───────────────────────────
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    const thisMonthEscrows = await this.prisma.escrow.aggregate({
      where: {
        request: { providerId: userId },
        status: 'RELEASED',
        releasedAt: { gte: monthStart },
      },
      _sum: { amount: true },
    });

    const grossThisMonth = +Number(thisMonthEscrows._sum.amount ?? 0).toFixed(2);
    const commissionThisMonth = +(grossThisMonth * HOME_SERVICES_COMMISSION).toFixed(2);

    return {
      lifetime: {
        gross: grossLifetime,
        commission: commissionLifetime,
        net: netLifetime,
        commissionRate: `${HOME_SERVICES_COMMISSION * 100}%`,
      },
      thisMonth: {
        gross: grossThisMonth,
        commission: commissionThisMonth,
        net: +(grossThisMonth - commissionThisMonth).toFixed(2),
      },
      pending: {
        amount: await this.prisma.escrow
          .aggregate({
            where: { request: { providerId: userId }, status: 'HELD' },
            _sum: { amount: true },
          })
          .then((r) => +Number(r._sum.amount ?? 0).toFixed(2)),
      },
      weeklyTrend,
      monthlyTrend,
      recentJobs: jobBreakdown,
    };
  }

  // ── Document Submission (provider onboarding) ────────────────────────────────

  async submitDocuments(userId: string, docKeys: string[]) {
    const profile = await this.prisma.providerProfile.findUnique({ where: { userId } });
    if (!profile) throw new NotFoundException('Provider profile not found');

    const allowedStatuses = ['PENDING_SUBMISSION', 'REJECTED'];
    if (!allowedStatuses.includes(profile.verificationStatus)) {
      throw new BadRequestException(
        `Cannot submit documents when status is ${profile.verificationStatus}`,
      );
    }

    const updated = await this.prisma.providerProfile.update({
      where: { userId },
      data: {
        submittedDocs: docKeys,
        docsSubmittedAt: new Date(),
        verificationStatus: 'PENDING_REVIEW',
        // Reset rejection data on re-submission
        rejectedAt: null,
        rejectionReason: null,
      },
    });

    this.events.emit('provider.docs_submitted', { userId, profileId: profile.id });
    return {
      message: 'Documents submitted successfully. Our team will review within 2-3 business days.',
    };
  }

  async getMyProfile(userId: string) {
    return this.prisma.providerProfile.findUnique({
      where: { userId },
      include: { skills: { include: { service: true } }, availability: true },
    });
  }

  async getMySkills(userId: string) {
    return this.prisma.providerSkill.findMany({
      where: { provider: { userId } },
      include: { service: true },
    });
  }

  async getMyAvailability(userId: string) {
    return this.prisma.providerAvailability.findMany({
      where: { provider: { userId } },
      orderBy: { dayOfWeek: 'asc' },
    });
  }

  async getVerificationStatus(userId: string) {
    const profile = await this.prisma.providerProfile.findUnique({
      where: { userId },
      select: {
        verificationStatus: true,
        docsSubmittedAt: true,
        reviewStartedAt: true,
        approvedAt: true,
        rejectedAt: true,
        rejectionReason: true,
        suspendedAt: true,
        suspensionReason: true,
      },
    });
    if (!profile) throw new NotFoundException('Provider profile not found');
    return profile;
  }
}
