import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateRequestDto } from './dto/create-request.dto';
import { CreateQuoteDto } from './dto/create-quote.dto';
import { PaginationDto, paginate } from '../../common/dto/pagination.dto';
import { RequestStatus, UserRole, QuoteStatus } from '@prisma/client';

@Injectable()
export class RequestsService {
  constructor(
    private prisma: PrismaService,
    private events: EventEmitter2,
  ) {}

  async create(customerId: string, dto: CreateRequestDto) {
    const request = await this.prisma.serviceRequest.create({
      data: {
        customerId,
        serviceId: dto.serviceId,
        city: dto.city,
        description: dto.description,
        indoorOutdoor: dto.indoorOutdoor,
        size: dto.size,
        urgency: dto.urgency,
        scheduledAt: dto.scheduledAt ? new Date(dto.scheduledAt) : undefined,
      },
      include: { service: true, customer: { include: { profile: true } } },
    });

    this.events.emit('request.created', {
      requestId: request.id,
      customerId,
      serviceId: dto.serviceId,
      city: request.city,
    });
    return request;
  }

  async findMyRequests(
    userId: string,
    role: UserRole,
    dto: PaginationDto & { status?: RequestStatus },
  ) {
    const where: any = {};
    if (role === UserRole.CUSTOMER) where.customerId = userId;
    else if (role === UserRole.PROVIDER) where.providerId = userId;

    if (dto.status) where.status = dto.status;

    const [requests, total] = await Promise.all([
      this.prisma.serviceRequest.findMany({
        where,
        include: {
          service: true,
          quotes: true,
          customer: { include: { profile: true } },
          provider: { include: { profile: true } },
        },
        skip: dto.skip,
        take: dto.limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.serviceRequest.count({ where }),
    ]);

    return paginate(requests, total, dto);
  }

  async findById(requestId: string, userId: string, role: UserRole) {
    const request = await this.prisma.serviceRequest.findUnique({
      where: { id: requestId },
      include: {
        service: true,
        quotes: { include: { provider: { include: { profile: true, providerProfile: true } } } },
        customer: { include: { profile: true } },
        provider: { include: { profile: true } },
        messages: { orderBy: { createdAt: 'asc' }, take: 50 },
      },
    });

    if (!request) throw new NotFoundException('Request not found');

    const isAdmin = (
      [UserRole.ADMIN, UserRole.SUPER_ADMIN, UserRole.SUPPORT] as UserRole[]
    ).includes(role);
    const isParty = request.customerId === userId || request.providerId === userId;
    if (!isAdmin && !isParty) throw new ForbiddenException('Access denied');

    return request;
  }

  async cancel(requestId: string, userId: string) {
    const request = await this.prisma.serviceRequest.findUnique({ where: { id: requestId } });
    if (!request) throw new NotFoundException('Request not found');
    if (request.customerId !== userId) throw new ForbiddenException('Not your request');

    const cancellableStatuses: RequestStatus[] = [RequestStatus.PENDING, RequestStatus.QUOTED, RequestStatus.ACCEPTED];
    if (!cancellableStatuses.includes(request.status)) {
      throw new BadRequestException(
        'لا يمكن إلغاء هذا الطلب في وضعه الحالي',
      );
    }

    const updated = await this.prisma.serviceRequest.update({
      where: { id: requestId },
      data: { status: RequestStatus.CANCELLED },
    });

    // Atomically claim the HELD escrow — prevents race with autoReleaseEscrow
    const { count } = await this.prisma.escrow.updateMany({
      where: { requestId: request.id, status: 'HELD' },
      data: { status: 'REFUNDED' },
    });
    if (count > 0) {
      // Fetch the now-REFUNDED escrow to get its id and amount for the event
      const escrow = await this.prisma.escrow.findFirst({
        where: { requestId: request.id, status: 'REFUNDED' },
      });
      if (escrow) {
        this.events.emit('escrow.refund_on_cancel', {
          escrowId: escrow.id,
          requestId: request.id,
          customerId: request.customerId,
          amount: escrow.amount,
        });
      }
    }

    return updated;
  }

  async submitQuote(providerId: string, requestId: string, dto: CreateQuoteDto) {
    // Only APPROVED, non-suspended providers may submit quotes
    const providerProfile = await this.prisma.providerProfile.findUnique({
      where: { userId: providerId },
      select: { verificationStatus: true, user: { select: { suspended: true } } },
    });
    if (!providerProfile || providerProfile.verificationStatus !== 'APPROVED') {
      throw new ForbiddenException('Only approved providers can submit quotes');
    }
    if (providerProfile.user.suspended) {
      throw new ForbiddenException('Your account has been suspended');
    }

    const request = await this.prisma.serviceRequest.findUnique({ where: { id: requestId } });
    if (!request) throw new NotFoundException('Request not found');
    if (request.status !== RequestStatus.PENDING && request.status !== RequestStatus.QUOTED) {
      throw new BadRequestException('Cannot quote on this request');
    }

    const existing = await this.prisma.quote.findFirst({ where: { requestId, providerId } });
    if (existing) throw new ConflictException('You already submitted a quote for this request');

    const expiresAt = new Date(Date.now() + 48 * 60 * 60_000);

    const [quote] = await this.prisma.$transaction([
      this.prisma.quote.create({
        data: {
          requestId,
          providerId,
          amount: dto.amount,
          includesMaterials: dto.includesMaterials ?? false,
          message: dto.message,
          expiresAt,
        },
        include: { provider: { include: { profile: true, providerProfile: true } } },
      }),
      this.prisma.serviceRequest.update({
        where: { id: requestId },
        data: { status: RequestStatus.QUOTED },
      }),
    ]);

    this.events.emit('quote.submitted', {
      quoteId: quote.id,
      requestId,
      providerId,
      customerId: request.customerId,
    });
    return quote;
  }

  async acceptQuote(customerId: string, requestId: string, quoteId: string) {
    const request = await this.prisma.serviceRequest.findUnique({
      where: { id: requestId },
      include: { quotes: true },
    });
    if (!request) throw new NotFoundException('Request not found');
    if (request.customerId !== customerId) throw new ForbiddenException('Not your request');
    if (request.status !== RequestStatus.QUOTED)
      throw new BadRequestException('No quotes to accept');

    const quote = request.quotes.find((q) => q.id === quoteId);
    if (!quote) throw new NotFoundException('Quote not found');

    await this.prisma.$transaction([
      this.prisma.quote.update({ where: { id: quoteId }, data: { status: QuoteStatus.ACCEPTED } }),
      this.prisma.quote.updateMany({
        where: { requestId, id: { not: quoteId } },
        data: { status: QuoteStatus.REJECTED },
      }),
      this.prisma.serviceRequest.update({
        where: { id: requestId },
        data: { status: RequestStatus.ACCEPTED, providerId: quote.providerId },
      }),
    ]);

    this.events.emit('quote.accepted', {
      quoteId,
      requestId,
      providerId: quote.providerId,
      customerId,
      amount: quote.amount,
    });
    return { message: 'Quote accepted', providerId: quote.providerId, amount: quote.amount };
  }

  // ── Provider: mark work started ─────────────────────────────────────────

  async startWork(providerId: string, requestId: string) {
    const request = await this.prisma.serviceRequest.findUnique({ where: { id: requestId } });
    if (!request) throw new NotFoundException('Request not found');
    if (request.providerId !== providerId) throw new ForbiddenException('Not your request');
    if (request.status !== RequestStatus.ACCEPTED) {
      throw new BadRequestException('Request must be ACCEPTED before starting work');
    }

    const updated = await this.prisma.serviceRequest.update({
      where: { id: requestId },
      data: { status: RequestStatus.IN_PROGRESS },
    });

    this.events.emit('request.status_changed', { requestId, status: 'IN_PROGRESS', providerId });
    return updated;
  }

  // ── Provider: mark work completed ────────────────────────────────────────

  async completeWork(providerId: string, requestId: string) {
    const request = await this.prisma.serviceRequest.findUnique({ where: { id: requestId } });
    if (!request) throw new NotFoundException('Request not found');
    if (request.providerId !== providerId) throw new ForbiddenException('Not your request');
    if (request.status !== RequestStatus.IN_PROGRESS) {
      throw new BadRequestException('Request must be IN_PROGRESS before marking complete');
    }

    // Atomic: only the caller that transitions the status is allowed to increment completedJobs
    const updated = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.serviceRequest.updateMany({
        where: { id: requestId, status: RequestStatus.IN_PROGRESS },
        data: { status: RequestStatus.COMPLETED, completedAt: new Date() },
      });
      if (count === 0)
        throw new BadRequestException('Request was already completed by another call');

      await tx.providerProfile.update({
        where: { userId: providerId },
        data: { completedJobs: { increment: 1 } },
      });

      return tx.serviceRequest.findUnique({ where: { id: requestId } });
    });

    this.events.emit('request.status_changed', {
      requestId,
      status: 'COMPLETED',
      providerId,
      customerId: request.customerId,
    });
    this.events.emit('request.completed', {
      requestId,
      providerId,
      customerId: request.customerId,
    });

    return updated;
  }
}
