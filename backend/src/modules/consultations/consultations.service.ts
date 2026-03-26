import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateConsultationDto } from './dto/create-consultation.dto';
import { RateConsultationDto } from './dto/rate-consultation.dto';
import { PaginationDto, paginate } from '../../common/dto/pagination.dto';
import { ConsultationStatus, UserRole, ProviderVerificationStatus } from '@prisma/client';

@Injectable()
export class ConsultationsService {
  constructor(
    private prisma: PrismaService,
    private events: EventEmitter2,
  ) {}

  // ── Customer: create consultation request ─────────────────────────────────
  async create(customerId: string, dto: CreateConsultationDto) {
    const consultation = await this.prisma.consultation.create({
      data: {
        customerId,
        serviceId: dto.serviceId,
        topic: dto.topic,
        description: dto.description,
        mode: dto.mode,
        durationMinutes: dto.durationMinutes,
        scheduledAt: dto.scheduledAt ? new Date(dto.scheduledAt) : undefined,
        pricePerHour: dto.pricePerHour,
      },
      include: {
        service: { select: { nameAr: true, nameEn: true, icon: true } },
        customer: { include: { profile: true } },
      },
    });

    this.events.emit('consultation.created', {
      consultationId: consultation.id,
      customerId,
      serviceId: dto.serviceId,
    });

    return consultation;
  }

  // ── List consultations (customer sees own, provider sees assigned) ─────────
  async findMine(
    userId: string,
    role: UserRole,
    dto: PaginationDto & { status?: ConsultationStatus },
  ) {
    const where: any = {};
    if (role === UserRole.CUSTOMER) where.customerId = userId;
    else if (role === UserRole.PROVIDER) where.providerId = userId;

    if (dto.status) where.status = dto.status;

    const [items, total] = await Promise.all([
      this.prisma.consultation.findMany({
        where,
        include: {
          service: { select: { nameAr: true, nameEn: true, icon: true } },
          customer: { include: { profile: true } },
          provider: { include: { profile: true, providerProfile: true } },
        },
        skip: dto.skip,
        take: dto.limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.consultation.count({ where }),
    ]);

    return paginate(items, total, dto);
  }

  // ── Get single consultation ───────────────────────────────────────────────
  async findById(consultationId: string, userId: string, role: UserRole) {
    const consultation = await this.prisma.consultation.findUnique({
      where: { id: consultationId },
      include: {
        service: { select: { nameAr: true, nameEn: true, icon: true } },
        customer: { include: { profile: true } },
        provider: { include: { profile: true, providerProfile: true } },
      },
    });

    if (!consultation) throw new NotFoundException('Consultation not found');

    const isAdmin = (
      [UserRole.ADMIN, UserRole.SUPER_ADMIN, UserRole.SUPPORT] as UserRole[]
    ).includes(role);
    const isParty = consultation.customerId === userId || consultation.providerId === userId;

    if (!isAdmin && !isParty) throw new ForbiddenException('Access denied');

    return consultation;
  }

  // ── Provider: accept consultation request ────────────────────────────────
  async accept(providerId: string, consultationId: string) {
    const providerProfile = await this.prisma.providerProfile.findFirst({
      where: {
        userId: providerId,
        verificationStatus: ProviderVerificationStatus.APPROVED,
        user: { suspended: false, deletedAt: null },
      },
    });
    if (!providerProfile) throw new ForbiddenException('Provider is not approved to accept consultations');

    // Fetch the consultation to check for scheduling conflicts
    const consultation = await this.prisma.consultation.findUnique({
      where: { id: consultationId },
      select: { scheduledAt: true, durationMinutes: true },
    });
    if (!consultation) throw new BadRequestException('Consultation is no longer available');

    // Check provider doesn't have an overlapping consultation
    if (consultation.scheduledAt) {
      const scheduledAt = consultation.scheduledAt;
      const durationMs = (consultation.durationMinutes || 60) * 60 * 1000;
      const endTime = new Date(scheduledAt.getTime() + durationMs);

      const conflict = await this.prisma.consultation.findFirst({
        where: {
          providerId,
          id: { not: consultationId },
          status: { in: [ConsultationStatus.ACCEPTED, ConsultationStatus.IN_SESSION] },
          scheduledAt: { gte: scheduledAt, lt: endTime },
        },
      });
      if (conflict) {
        this.events.emit('consultation.conflict_detected', {
          consultationId,
          providerId,
          scheduledAt: consultation.scheduledAt,
        });
        throw new ConflictException('لديك استشارة أخرى مجدولة في نفس الوقت');
      }
    }

    const { count } = await this.prisma.consultation.updateMany({
      where: { id: consultationId, status: ConsultationStatus.PENDING },
      data: { status: ConsultationStatus.ACCEPTED, providerId },
    });
    if (count === 0) throw new BadRequestException('Consultation is no longer available');

    const updated = await this.prisma.consultation.findUniqueOrThrow({ where: { id: consultationId } });

    this.events.emit('consultation.accepted', {
      consultationId,
      providerId,
      customerId: updated.customerId,
    });

    return updated;
  }

  // ── Provider: reject consultation request ────────────────────────────────
  async reject(providerId: string, consultationId: string) {
    const c = await this.prisma.consultation.findUnique({ where: { id: consultationId } });
    if (!c) throw new NotFoundException('Consultation not found');
    if (c.status !== ConsultationStatus.PENDING) {
      throw new BadRequestException(
        `Cannot perform this action on a consultation with status: ${c.status}`,
      );
    }
    // Only the targeted provider may reject. If providerId is already set on the
    // consultation, the caller must match it.
    if (c.providerId && c.providerId !== providerId) {
      throw new ForbiddenException('Not your consultation');
    }

    return this.prisma.consultation.update({
      where: { id: consultationId },
      data: { status: ConsultationStatus.REJECTED },
    });
  }

  // ── Provider: mark session started ───────────────────────────────────────
  async startSession(providerId: string, consultationId: string) {
    const c = await this._getAndAssertProvider(consultationId, providerId, [
      ConsultationStatus.ACCEPTED,
    ]);

    const updated = await this.prisma.consultation.update({
      where: { id: consultationId },
      data: { status: ConsultationStatus.IN_SESSION, startedAt: new Date() },
    });

    this.events.emit('consultation.started', {
      consultationId,
      providerId,
      customerId: c.customerId,
    });

    return updated;
  }

  // ── Provider: complete session ────────────────────────────────────────────
  async complete(providerId: string, consultationId: string, notes?: string) {
    const c = await this._getAndAssertProvider(consultationId, providerId, [
      ConsultationStatus.IN_SESSION,
    ]);

    // Calculate total based on actual duration (startedAt → now) and pricePerHour
    let totalAmount = c.totalAmount;
    if (c.startedAt && c.pricePerHour) {
      const hoursElapsed = (Date.now() - c.startedAt.getTime()) / (1000 * 60 * 60);
      if (!isFinite(hoursElapsed) || hoursElapsed < 0) {
        throw new BadRequestException('مدة الاستشارة غير صحيحة');
      }
      (totalAmount as any) = parseFloat((Number(c.pricePerHour) * Math.max(hoursElapsed, 0.25)).toFixed(2)); // min 15 min charge, rounded to 2dp
    }

    const { count } = await this.prisma.consultation.updateMany({
      where: { id: consultationId, status: ConsultationStatus.IN_SESSION },
      data: {
        status: ConsultationStatus.COMPLETED,
        completedAt: new Date(),
        notes: notes ?? c.notes,
        totalAmount: totalAmount ?? undefined,
      },
    });
    if (count === 0) throw new BadRequestException('Consultation is no longer in session');

    // Re-fetch to return updated record
    const updated = await this.prisma.consultation.findUniqueOrThrow({ where: { id: consultationId } });

    this.events.emit('consultation.completed', {
      consultationId,
      providerId,
      customerId: c.customerId,
    });

    if (totalAmount && Number(totalAmount) > 0) {
      this.events.emit('consultation.charge_required', {
        consultationId,
        customerId: c.customerId,
        providerId,
        amount: parseFloat(Number(totalAmount).toFixed(2)),
      });
    }

    return updated;
  }

  // ── Customer: cancel ──────────────────────────────────────────────────────
  async cancel(customerId: string, consultationId: string) {
    const c = await this.prisma.consultation.findUnique({
      where: { id: consultationId },
    });

    if (!c) throw new NotFoundException('Consultation not found');
    if (c.customerId !== customerId) throw new ForbiddenException('Not your consultation');

    const cancellable: ConsultationStatus[] = [
      ConsultationStatus.PENDING,
      ConsultationStatus.ACCEPTED,
    ];
    if (!cancellable.includes(c.status)) {
      throw new BadRequestException(
        'Cannot cancel a consultation that is already in session or completed',
      );
    }

    const updated = await this.prisma.consultation.update({
      where: { id: consultationId },
      data: { status: ConsultationStatus.CANCELLED },
    });
    this.events.emit('consultation.cancelled', {
      consultationId,
      cancelledBy: 'customer',
      customerId,
      providerId: c.providerId,
    });
    return updated;
  }

  // ── Provider: cancel (PENDING or ACCEPTED only) ───────────────────────────
  async cancelByProvider(providerId: string, consultationId: string) {
    const c = await this.prisma.consultation.findUnique({
      where: { id: consultationId },
    });

    if (!c) throw new NotFoundException('Consultation not found');
    if (c.providerId !== providerId) throw new ForbiddenException('Not your consultation');

    // Provider cannot cancel once the session is underway
    const cancellable: ConsultationStatus[] = [
      ConsultationStatus.PENDING,
      ConsultationStatus.ACCEPTED,
    ];
    if (!cancellable.includes(c.status)) {
      throw new BadRequestException(
        'يمكن إلغاء الاستشارة فقط قبل بدء الجلسة',
      );
    }

    const updated = await this.prisma.consultation.update({
      where: { id: consultationId },
      data: { status: ConsultationStatus.CANCELLED },
    });
    this.events.emit('consultation.cancelled', {
      consultationId,
      cancelledBy: 'provider',
      customerId: c.customerId,
      providerId,
    });
    return updated;
  }

  // ── Customer: rate completed session ─────────────────────────────────────
  async rate(customerId: string, consultationId: string, dto: RateConsultationDto) {
    const c = await this.prisma.consultation.findUnique({
      where: { id: consultationId },
    });

    if (!c) throw new NotFoundException('Consultation not found');
    if (c.customerId !== customerId) throw new ForbiddenException('Not your consultation');
    if (c.status !== ConsultationStatus.COMPLETED) {
      throw new BadRequestException('Can only rate completed consultations');
    }
    if (c.rating !== null) {
      throw new BadRequestException('Already rated');
    }

    const updated = await this.prisma.consultation.update({
      where: { id: consultationId },
      data: { rating: dto.rating, notes: dto.notes ?? c.notes },
    });

    this.events.emit('consultation.rated', {
      consultationId,
      rating: dto.rating,
      providerId: c.providerId,
      customerId,
    });

    return updated;
  }

  // ── Admin: list all ───────────────────────────────────────────────────────
  async findAll(dto: PaginationDto & { status?: ConsultationStatus }) {
    const where: any = {};
    if (dto.status) where.status = dto.status;

    const [items, total] = await Promise.all([
      this.prisma.consultation.findMany({
        where,
        include: {
          service: { select: { nameAr: true, icon: true } },
          customer: { include: { profile: true } },
          provider: { include: { profile: true } },
        },
        skip: dto.skip,
        take: dto.limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.consultation.count({ where }),
    ]);

    return paginate(items, total, dto);
  }

  // ── Private helpers ───────────────────────────────────────────────────────
  private async _getAndAssertProvider(
    consultationId: string,
    providerId: string,
    allowedStatuses: ConsultationStatus[],
  ) {
    const c = await this.prisma.consultation.findUnique({
      where: { id: consultationId },
    });

    if (!c) throw new NotFoundException('Consultation not found');

    // Allow any provider to accept PENDING consultations; otherwise enforce ownership
    const isPendingAccept =
      c.status === ConsultationStatus.PENDING &&
      allowedStatuses.includes(ConsultationStatus.PENDING);

    if (!isPendingAccept && c.providerId !== providerId) {
      throw new ForbiddenException('Not your consultation');
    }

    if (!allowedStatuses.includes(c.status)) {
      throw new BadRequestException(
        `Cannot perform this action on a consultation with status: ${c.status}`,
      );
    }

    return c;
  }
}
