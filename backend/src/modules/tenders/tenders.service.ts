import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CompaniesService } from '../companies/companies.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { RequirementStatus, TenderStatus, CommissionStatus } from '@prisma/client';
import { PaginationDto, paginate } from '../../common/dto/pagination.dto';

const COMMISSION_RATE = 0.02;

@Injectable()
export class TendersService {
  constructor(
    private prisma: PrismaService,
    private companies: CompaniesService,
    private events: EventEmitter2,
  ) {}

  // ── Tenders ──────────────────────────────────────────────────────────────

  async list(
    filters: { status?: string; category?: string; region?: string } = {},
    pagination: PaginationDto = new PaginationDto(),
  ) {
    const where = {
      status: (filters.status as TenderStatus | undefined) ?? TenderStatus.OPEN,
      category: filters.category || undefined,
      region: filters.region || undefined,
    };
    const [items, total] = await Promise.all([
      this.prisma.tender.findMany({
        where,
        include: {
          company: { select: { id: true, nameAr: true, classification: true, verified: true } },
          // Intentionally NO _count.bids — exposing bid count violates bid privacy rules.
        },
        orderBy: { createdAt: 'desc' },
        skip: pagination.skip,
        take: pagination.limit,
      }),
      this.prisma.tender.count({ where }),
    ]);
    return paginate(items, total, pagination);
  }

  /**
   * Returns tender detail with caller-aware bid visibility:
   * - Tender owner  → no bids here; use GET /tenders/:id/bids instead
   * - Bidder        → only their own bid (amount, status, timestamps)
   * - Anyone else   → tender details only, no bid data
   *
   * This method NEVER returns competitor bid information.
   */
  async get(id: string, callerId: string | undefined) {
    const tender = await this.prisma.tender.findUnique({
      where: { id },
      include: {
        company: {
          select: {
            id: true,
            nameAr: true,
            nameEn: true,
            classification: true,
            verified: true,
            rating: true,
            ownerId: true,
          },
        },
        requirements: { include: { _count: { select: { offers: true } } } },
      },
    });
    if (!tender) throw new NotFoundException('Tender not found');

    const isOwner = callerId ? tender.company.ownerId === callerId : false;

    // Fetch caller's own bid (bidders only; owner uses listBids())
    const myBid = isOwner || !callerId
      ? undefined
      : ((await this.prisma.tenderBid.findFirst({
          where: { tenderId: id, submittedBy: callerId },
          select: {
            id: true,
            amount: true,
            status: true,
            durationMonths: true,
            note: true,
            createdAt: true,
            updatedAt: true,
          },
        })) ?? undefined);

    // Strip internal ownerId from response
    const { ownerId: _ownerId, ...company } = tender.company;
    return { ...tender, company, myBid };
  }

  /**
   * Returns ALL bids for a tender — restricted to the tender owner only.
   * Includes company name, rating, and proposal details for each bidder.
   */
  async listBids(tenderId: string, callerId: string, pagination: PaginationDto = new PaginationDto()) {
    const tender = await this.prisma.tender.findUnique({
      where: { id: tenderId },
      include: { company: { select: { ownerId: true } } },
    });
    if (!tender) throw new NotFoundException('Tender not found');
    if (tender.company.ownerId !== callerId) {
      throw new ForbiddenException('Only the tender owner can view submitted bids');
    }

    const where = { tenderId };
    const [items, total] = await Promise.all([
      this.prisma.tenderBid.findMany({
        where,
        include: {
          company: {
            select: {
              id: true,
              nameAr: true,
              nameEn: true,
              classification: true,
              verified: true,
              rating: true,
              region: true,
              city: true,
            },
          },
          submitter: { select: { id: true, username: true } },
        },
        orderBy: { amount: 'asc' },
        skip: pagination.skip,
        take: pagination.limit,
      }),
      this.prisma.tenderBid.count({ where }),
    ]);
    return paginate(items, total, pagination);
  }

  async create(userId: string, data: Record<string, any>) {
    const company = await this.companies.getMyCompany(userId);

    // Allowlist: only fields the submitting company owner may set.
    // companyId is always sourced from the authenticated user's company — never from input.
    const { title, description, category, region, city, budget, deadline, attachments } = data;
    const safeData = Object.fromEntries(
      Object.entries({ title, description, category, region, city, budget, deadline, attachments })
        .filter(([, v]) => v !== undefined),
    );

    return this.prisma.tender.create({
      data: { companyId: company.id, ...safeData } as any,
    });
  }

  async award(tenderId: string, winningBidId: string, userId: string) {
    const tender = await this.prisma.tender.findUnique({
      where: { id: tenderId },
      include: { company: { select: { ownerId: true } } },
    });
    if (!tender) throw new NotFoundException('Tender not found');
    if (tender.company.ownerId !== userId) throw new ForbiddenException();
    if (tender.status !== 'OPEN') throw new BadRequestException('Tender is not open');

    const bid = await this.prisma.tenderBid.findUnique({ where: { id: winningBidId } });
    if (!bid || bid.tenderId !== tenderId) throw new NotFoundException('Bid not found');

    const commissionAmount = +(Number(bid.amount) * COMMISSION_RATE).toFixed(2);
    const winnerCompanyId = bid.companyId;
    const winnerId = bid.submittedBy;

    await this.prisma.$transaction(async (tx) => {
      // Atomic guard: only proceed if WE transition the status from OPEN → AWARDED
      const { count } = await tx.tender.updateMany({
        where: { id: tenderId, status: 'OPEN' },
        data: { status: 'AWARDED', awardedAt: new Date() },
      });
      if (count === 0) throw new BadRequestException('Tender has already been awarded');

      await tx.tenderBid.update({
        where: { id: winningBidId },
        data: { status: 'WON' },
      });
      await tx.tenderBid.updateMany({
        where: { tenderId, id: { not: winningBidId }, status: 'PENDING' },
        data: { status: 'REJECTED' },
      });
      await tx.tenderCommission.create({
        data: {
          tenderId,
          bidId: winningBidId,
          companyId: winnerCompanyId,
          tenderValue: bid.amount,
          commissionRate: COMMISSION_RATE,
          commissionAmount,
          status: 'IN_PROGRESS',
          projectStartedAt: new Date(),
        },
      });
    });

    this.events.emit('tender.awarded', { tenderId, winningBidId, commissionAmount, winnerId });
    return { ok: true, commissionAmount };
  }

  // ── Bids ─────────────────────────────────────────────────────────────────

  async submitBid(tenderId: string, userId: string, data: Record<string, any>) {
    if (!data.termsAccepted) {
      throw new BadRequestException('Terms and conditions must be accepted');
    }

    const tender = await this.prisma.tender.findUnique({
      where: { id: tenderId },
      include: { company: { select: { ownerId: true } } },
    });
    if (!tender) throw new NotFoundException('Tender not found');
    if (tender.status !== 'OPEN')
      throw new BadRequestException('This tender is no longer accepting bids');
    if (new Date() > tender.deadline)
      throw new BadRequestException('The deadline for this tender has passed');
    if (tender.company.ownerId === userId)
      throw new ForbiddenException('You cannot bid on your own tender');

    let companyId: string | null = null;
    try {
      const co = await this.companies.getMyCompany(userId);
      companyId = co.id;
    } catch {}

    // Prevent duplicate bids — check by companyId (when available) or by submittedBy
    const existing = await this.prisma.tenderBid.findFirst({
      where: companyId ? { tenderId, companyId } : { tenderId, submittedBy: userId },
    });
    if (existing) throw new BadRequestException('You have already submitted a bid for this tender');

    const bid = await this.prisma.tenderBid.create({
      data: {
        tenderId,
        companyId,
        submittedBy: userId,
        amount: data.amount,
        durationMonths: data.durationMonths,
        note: data.note,
        status: 'PENDING',
        termsAccepted: true,
        termsAcceptedAt: new Date(),
      },
    });

    this.events.emit('tender.bid_submitted', { tenderId, bidId: bid.id, userId });
    return bid;
  }

  /**
   * Allows a bidder to update their own bid before the deadline.
   * Cannot edit after deadline or once the tender is no longer OPEN.
   */
  async updateBid(
    tenderId: string,
    bidId: string,
    userId: string,
    data: { amount?: number; durationMonths?: number; note?: string },
  ) {
    const bid = await this.prisma.tenderBid.findUnique({
      where: { id: bidId },
      include: { tender: { select: { status: true, deadline: true } } },
    });
    if (!bid || bid.tenderId !== tenderId) throw new NotFoundException('Bid not found');
    if (bid.submittedBy !== userId) throw new ForbiddenException('You can only edit your own bids');
    if (bid.tender.status !== 'OPEN')
      throw new BadRequestException('Cannot edit a bid after the tender has closed');
    if (new Date() > bid.tender.deadline)
      throw new BadRequestException('Cannot edit a bid after the deadline');
    if (bid.status !== 'PENDING') throw new BadRequestException('Only pending bids can be edited');

    return this.prisma.tenderBid.update({
      where: { id: bidId },
      data: {
        amount: data.amount !== undefined ? data.amount : undefined,
        durationMonths: data.durationMonths !== undefined ? data.durationMonths : undefined,
        note: data.note !== undefined ? data.note : undefined,
      },
    });
  }

  /**
   * Allows a bidder to withdraw their own pending bid before the deadline.
   */
  async withdrawBid(tenderId: string, bidId: string, userId: string) {
    const bid = await this.prisma.tenderBid.findUnique({
      where: { id: bidId },
      include: { tender: { select: { status: true, deadline: true } } },
    });
    if (!bid || bid.tenderId !== tenderId) throw new NotFoundException('Bid not found');
    if (bid.submittedBy !== userId)
      throw new ForbiddenException('You can only withdraw your own bids');
    if (bid.tender.status !== 'OPEN')
      throw new BadRequestException('Cannot withdraw after the tender has closed');
    if (new Date() > bid.tender.deadline)
      throw new BadRequestException('Cannot withdraw after the deadline');
    if (bid.status !== 'PENDING')
      throw new BadRequestException('Only pending bids can be withdrawn');

    return this.prisma.tenderBid.update({
      where: { id: bidId },
      data: { status: 'WITHDRAWN' },
    });
  }

  async myBids(userId: string, pagination: PaginationDto = new PaginationDto()) {
    const where = { submittedBy: userId };
    const [items, total] = await Promise.all([
      this.prisma.tenderBid.findMany({
        where,
        include: { tender: { select: { id: true, title: true, status: true, deadline: true } } },
        orderBy: { createdAt: 'desc' },
        skip: pagination.skip,
        take: pagination.limit,
      }),
      this.prisma.tenderBid.count({ where }),
    ]);
    return paginate(items, total, pagination);
  }

  // ── Commissions ───────────────────────────────────────────────────────────

  async listCommissions(
    filters: { status?: string } = {},
    pagination: PaginationDto = new PaginationDto(),
  ) {
    const where = { status: (filters.status as CommissionStatus | undefined) || undefined };
    const [items, total] = await Promise.all([
      this.prisma.tenderCommission.findMany({
        where,
        include: {
          tender: { select: { id: true, title: true, category: true, region: true } },
          company: { select: { id: true, nameAr: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: pagination.skip,
        take: pagination.limit,
      }),
      this.prisma.tenderCommission.count({ where }),
    ]);
    return paginate(items, total, pagination);
  }

  async updateCommissionStatus(id: string, status: string) {
    const timestamps: Record<string, Record<string, Date>> = {
      IN_PROGRESS: { projectStartedAt: new Date() },
      COMPLETED: { projectCompletedAt: new Date() },
      INVOICE_ISSUED: { invoiceIssuedAt: new Date() },
      PAID: { paidAt: new Date() },
      OVERDUE: { overdueAt: new Date() },
    };

    return this.prisma.tenderCommission.update({
      where: { id },
      data: { status: status as any, ...timestamps[status] },
    });
  }

  // ── Requirements ─────────────────────────────────────────────────────────

  async createRequirement(tenderId: string, userId: string, data: Record<string, any>) {
    const tender = await this.prisma.tender.findUnique({
      where: { id: tenderId },
      include: { company: { select: { ownerId: true } } },
    });
    if (!tender) throw new NotFoundException('Tender not found');
    if (tender.company.ownerId !== userId)
      throw new ForbiddenException('Only the tender owner can add requirements');

    // Allowlist: only fields the tender owner may specify for a requirement.
    const { title, description, quantity, unit, estimatedBudget, deadline, specifications } = data;
    const safeData = Object.fromEntries(
      Object.entries({ title, description, quantity, unit, estimatedBudget, deadline, specifications })
        .filter(([, v]) => v !== undefined),
    );

    return this.prisma.projectRequirement.create({
      data: { tenderId, ...safeData } as any,
    });
  }

  async listRequirements(tenderId: string) {
    const tender = await this.prisma.tender.findUnique({ where: { id: tenderId }, select: { id: true } });
    if (!tender) throw new NotFoundException('Tender not found');
    return this.prisma.projectRequirement.findMany({
      where: { tenderId },
      take: 100,
      orderBy: { createdAt: 'asc' },
      include: { _count: { select: { offers: true } } },
    });
  }

  // ── Supplier Offers ───────────────────────────────────────────────────────

  async submitOffer(requirementId: string, userId: string, data: Record<string, any>) {
    const requirement = await this.prisma.projectRequirement.findUnique({
      where: { id: requirementId },
      include: { tender: { select: { status: true } } },
    });
    if (!requirement) throw new NotFoundException('Requirement not found');
    if (requirement.tender.status !== 'OPEN') {
      throw new BadRequestException('This tender is no longer accepting offers');
    }

    const existing = await this.prisma.supplierOffer.findFirst({
      where: { requirementId, supplierId: userId, status: { not: 'WITHDRAWN' as any } },
    });
    if (existing) throw new ConflictException('You have already submitted an offer for this requirement');

    let companyId: string | null = null;
    try {
      const co = await this.companies.getMyCompany(userId);
      companyId = co.id;
    } catch {}

    // Allowlist: only supplier-supplied fields. status is always 'PENDING' — never from input.
    const { price, deliveryDays, notes, attachments } = data;
    const safeData = Object.fromEntries(
      Object.entries({ price, deliveryDays, notes, attachments })
        .filter(([, v]) => v !== undefined),
    );

    return this.prisma.supplierOffer.create({
      data: { requirementId, supplierId: userId, companyId, status: 'PENDING', ...safeData } as any,
    });
  }

  async selectOffer(offerId: string, requirementId: string, userId: string) {
    // Verify caller owns the tender this requirement belongs to
    const requirement = await this.prisma.projectRequirement.findUnique({
      where: { id: requirementId },
      include: { tender: { include: { company: { select: { ownerId: true } } } } },
    });
    if (!requirement) throw new NotFoundException('Requirement not found');
    if (requirement.tender.company.ownerId !== userId) {
      throw new ForbiddenException('Only the tender owner can select a winning offer');
    }

    // Verify the offer belongs to this requirement
    const offer = await this.prisma.supplierOffer.findUnique({ where: { id: offerId } });
    if (!offer || offer.requirementId !== requirementId) throw new NotFoundException('Offer not found');

    await this.prisma.$transaction([
      this.prisma.supplierOffer.update({ where: { id: offerId }, data: { status: 'ACCEPTED' } }),
      this.prisma.supplierOffer.updateMany({
        where: { requirementId, id: { not: offerId } },
        data: { status: 'REJECTED' },
      }),
      this.prisma.projectRequirement.update({
        where: { id: requirementId },
        data: { status: RequirementStatus.AWARDED },
      }),
    ]);
    return { ok: true };
  }
}
