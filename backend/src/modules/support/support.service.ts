import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../prisma/prisma.service';

export type TicketCategory =
  | 'PAYMENT'
  | 'PROVIDER_ISSUE'
  | 'SERVICE_QUALITY'
  | 'ACCOUNT'
  | 'TECHNICAL'
  | 'OTHER';

export type TicketPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';

@Injectable()
export class SupportService {
  constructor(
    private prisma: PrismaService,
    private events: EventEmitter2,
  ) {}

  // ── Open a ticket ──────────────────────────────────────────────────────────
  async openTicket(
    userId: string,
    subject: string,
    description: string,
    category: TicketCategory,
    priority: TicketPriority = 'MEDIUM',
    attachments: string[] = [],
    relatedRequestId?: string,
  ) {
    const ticket = await this.prisma.supportTicket.create({
      data: {
        userId,
        subject,
        description,
        category,
        priority,
        attachments,
        relatedRequestId,
        status: 'OPEN',
      },
    });

    this.events.emit('support.ticket_opened', { ticketId: ticket.id, userId, category, priority });
    return ticket;
  }

  // ── List user's own tickets ────────────────────────────────────────────────
  async listMine(userId: string, status?: string, page = 1, limit = 20) {
    const safeLimit = Math.min(Math.max(1, limit), 50);
    const safePage  = Math.max(1, page);
    const skip = (safePage - 1) * safeLimit;

    const VALID_STATUSES = ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'] as const;
    const where: any = { userId };
    if (status) {
      if (!(VALID_STATUSES as readonly string[]).includes(status)) {
        throw new UnprocessableEntityException(`Invalid status: ${status}`);
      }
      where.status = status;
    }
    const [tickets, total] = await Promise.all([
      this.prisma.supportTicket.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        include: { messages: { orderBy: { createdAt: 'asc' }, take: 1 } },
        skip,
        take: safeLimit,
      }),
      this.prisma.supportTicket.count({ where }),
    ]);
    return { tickets, total, page: safePage, pages: Math.ceil(total / safeLimit) };
  }

  // ── Get single ticket ──────────────────────────────────────────────────────
  async getTicket(userId: string, ticketId: string, isAdmin = false) {
    const ticket = await this.prisma.supportTicket.findUnique({
      where: { id: ticketId },
      include: {
        messages: { orderBy: { createdAt: 'asc' } },
        user: { include: { profile: true } },
        assignee: { include: { profile: true } },
      },
    });
    if (!ticket) throw new NotFoundException('Ticket not found');
    if (!isAdmin && ticket.userId !== userId) throw new ForbiddenException('Access denied');
    return ticket;
  }

  // ── Add message to ticket ──────────────────────────────────────────────────
  async addMessage(userId: string, ticketId: string, content: string, isAdmin = false) {
    const ticket = await this.prisma.supportTicket.findUnique({ where: { id: ticketId } });
    if (!ticket) throw new NotFoundException('Ticket not found');
    if (!isAdmin && ticket.userId !== userId) throw new ForbiddenException('Access denied');
    if (ticket.status === 'CLOSED')
      throw new BadRequestException('Cannot reply to a closed ticket');

    const [message] = await this.prisma.$transaction([
      this.prisma.supportMessage.create({
        data: { ticketId, senderId: userId, content, isStaff: isAdmin },
      }),
      // Merge status update (if needed) and lastReplyAt into one atomic write
      this.prisma.supportTicket.update({
        where: { id: ticketId },
        data: {
          lastReplyAt: new Date(),
          ...(!isAdmin && ticket.status === 'RESOLVED'
            ? { status: 'OPEN', resolvedAt: null }
            : {}),
        },
      }),
    ]);

    // Emit event AFTER the transaction commits so the state is consistent
    if (!isAdmin && ticket.status === 'RESOLVED') {
      this.events.emit('support.ticket_reopened', { ticketId, userId });
    }

    return message;
  }

  // ── Admin: list all tickets ────────────────────────────────────────────────
  async adminList(
    filters: {
      status?: string;
      priority?: string;
      category?: string;
      assigneeId?: string;
      page?: number;
      limit?: number;
    } = {},
  ) {
    const rawPage  = Math.max(1, filters.page  ?? 1);
    const rawLimit = Math.min(Math.max(1, filters.limit ?? 20), 100);
    const skip = (rawPage - 1) * rawLimit;
    const where: any = {};
    if (filters.status)     where.status     = filters.status;
    if (filters.priority)   where.priority   = filters.priority;
    if (filters.category)   where.category   = filters.category;
    if (filters.assigneeId) where.assigneeId = filters.assigneeId;

    const [tickets, total] = await Promise.all([
      this.prisma.supportTicket.findMany({
        where,
        skip,
        take: rawLimit,
        orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
        include: {
          user: { include: { profile: true } },
          assignee: { include: { profile: true } },
          _count: { select: { messages: true } },
        },
      }),
      this.prisma.supportTicket.count({ where }),
    ]);

    return { tickets, total, page: rawPage, pages: Math.ceil(total / rawLimit) };
  }

  // ── Admin: assign ticket to staff ─────────────────────────────────────────
  async assignTicket(ticketId: string, assigneeId: string) {
    return this.prisma.supportTicket.update({
      where: { id: ticketId },
      data: { assigneeId, status: 'IN_PROGRESS' },
    });
  }

  // ── Admin: update ticket status ────────────────────────────────────────────
  async updateStatus(ticketId: string, status: string) {
    const ALLOWED = ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'] as const;
    if (!(ALLOWED as readonly string[]).includes(status)) {
      throw new BadRequestException(`Invalid status: ${status}`);
    }
    const ticket = await this.prisma.supportTicket.findUnique({ where: { id: ticketId } });
    if (!ticket) throw new NotFoundException('Ticket not found');
    const data: any = { status };
    if (status === 'RESOLVED') data.resolvedAt = new Date();
    if (status === 'CLOSED') {
      data.closedAt = new Date();
      // Ensure resolvedAt is set for SLA metric queries that filter on resolved_at IS NOT NULL
      if (!ticket.resolvedAt) data.resolvedAt = new Date();
    }
    return this.prisma.supportTicket.update({ where: { id: ticketId }, data });
  }

  // ── Admin: SLA metrics ────────────────────────────────────────────────────
  async getSlaMetrics() {
    const now = new Date();
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const [open, urgent, avgResolution] = await Promise.all([
      this.prisma.supportTicket.count({ where: { status: { in: ['OPEN', 'IN_PROGRESS'] } } }),
      this.prisma.supportTicket.count({ where: { status: 'OPEN', priority: 'URGENT' } }),
      this.prisma.$queryRaw<any[]>`
        SELECT
          AVG(EXTRACT(EPOCH FROM (resolved_at - created_at)) / 3600) AS avg_hours
        FROM support_tickets
        WHERE status IN ('RESOLVED', 'CLOSED')
          AND resolved_at IS NOT NULL
          AND created_at >= ${dayAgo}
      `,
    ]);

    return {
      openTickets: open,
      urgentTickets: urgent,
      avgResolutionHours: Number(avgResolution[0]?.avg_hours ?? 0).toFixed(1),
    };
  }
}
