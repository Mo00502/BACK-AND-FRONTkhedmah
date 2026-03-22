import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class DisputesService {
  constructor(
    private prisma: PrismaService,
    private events: EventEmitter2,
  ) {}

  async openDispute(
    reporterId: string,
    requestId: string,
    reason: string,
    details?: string,
    evidence?: string[],
  ) {
    const request = await this.prisma.serviceRequest.findUnique({
      where: { id: requestId },
    });
    if (!request) throw new NotFoundException('Request not found');

    // Only the customer or provider of this request can open a dispute
    if (request.customerId !== reporterId && request.providerId !== reporterId) {
      throw new ForbiddenException('Not a participant in this request');
    }

    // Only requests in IN_PROGRESS or COMPLETED can be disputed
    if (!['IN_PROGRESS', 'COMPLETED'].includes(request.status)) {
      throw new BadRequestException('Only in-progress or completed requests can be disputed');
    }

    // Determine who is being disputed against
    const againstId = request.customerId === reporterId ? request.providerId! : request.customerId;

    // Check for existing open dispute
    const existing = await this.prisma.dispute.findFirst({
      where: { requestId, status: { in: ['OPEN', 'UNDER_REVIEW'] } },
    });
    if (existing) throw new BadRequestException('A dispute is already open for this request');

    const dispute = await this.prisma.dispute.create({
      data: { reporterId, requestId, againstId, reason, details, evidence: evidence || [] },
    });

    this.events.emit('dispute.opened', { disputeId: dispute.id, requestId, reporterId, againstId });
    return dispute;
  }

  async getDispute(userId: string, disputeId: string) {
    const dispute = await this.prisma.dispute.findUnique({
      where: { id: disputeId },
      include: {
        request: { include: { service: true } },
        reporter: { include: { profile: true } },
        against: { include: { profile: true } },
      },
    });
    if (!dispute) throw new NotFoundException('Dispute not found');

    // Only participants or admins can view
    if (dispute.reporterId !== userId && dispute.againstId !== userId) {
      throw new ForbiddenException('Access denied');
    }
    return dispute;
  }

  async listMyDisputes(userId: string) {
    return this.prisma.dispute.findMany({
      where: { OR: [{ reporterId: userId }, { againstId: userId }] },
      include: { request: { include: { service: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async addEvidence(userId: string, disputeId: string, fileUrls: string[]) {
    const dispute = await this.prisma.dispute.findUnique({ where: { id: disputeId } });
    if (!dispute) throw new NotFoundException('Dispute not found');
    if (dispute.reporterId !== userId && dispute.againstId !== userId)
      throw new ForbiddenException('Only dispute participants can add evidence');
    if (dispute.status !== 'OPEN')
      throw new BadRequestException('Can only add evidence to open disputes');

    return this.prisma.dispute.update({
      where: { id: disputeId },
      data: { evidence: { push: fileUrls } },
    });
  }

  async escalate(userId: string, disputeId: string) {
    const dispute = await this.prisma.dispute.findUnique({ where: { id: disputeId } });
    if (!dispute) throw new NotFoundException('Dispute not found');
    if (dispute.reporterId !== userId && dispute.againstId !== userId) {
      throw new ForbiddenException('Only dispute participants can escalate');
    }
    if (dispute.status !== 'OPEN')
      throw new BadRequestException('Only open disputes can be escalated');

    return this.prisma.dispute.update({
      where: { id: disputeId },
      data: { status: 'UNDER_REVIEW' },
    });
  }
}
