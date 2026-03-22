import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CreateReviewDto } from './dto/create-review.dto';
import { Decimal } from '@prisma/client/runtime/library';

@Injectable()
export class ReviewsService {
  constructor(
    private prisma: PrismaService,
    private events: EventEmitter2,
  ) {}

  async create(raterId: string, requestId: string, dto: CreateReviewDto) {
    const request = await this.prisma.serviceRequest.findUnique({
      where: { id: requestId },
      include: { customer: true, provider: true },
    });

    if (!request) throw new NotFoundException('Request not found');
    if (request.status !== 'COMPLETED')
      throw new BadRequestException('Request must be completed to review');

    const isCustomer = request.customerId === raterId;
    const isProvider = request.providerId === raterId;

    if (!isCustomer && !isProvider)
      throw new ForbiddenException('You are not part of this request');

    const rateeId = isCustomer ? request.providerId! : request.customerId;

    const existing = await this.prisma.review.findUnique({
      where: { requestId_raterId: { requestId, raterId } },
    });
    if (existing) throw new ConflictException('You already reviewed this request');

    const review = await this.prisma.review.create({
      data: {
        requestId,
        raterId,
        rateeId,
        score: dto.score,
        comment: dto.comment,
        photos: dto.photos || [],
      },
    });

    // Update provider rating average
    if (isCustomer) {
      const stats = await this.prisma.review.aggregate({
        where: { rateeId },
        _avg: { score: true },
        _count: { id: true },
      });
      await this.prisma.providerProfile.update({
        where: { userId: rateeId },
        data: {
          ratingAvg: new Decimal(stats._avg.score ?? 0),
          ratingCount: stats._count.id,
        },
      });
    }

    this.events.emit('review.submitted', {
      reviewId: review.id,
      raterId,
      rateeId,
      requestId,
      score: dto.score,
      isCustomerReview: isCustomer,
    });

    return review;
  }

  async getProviderReviews(providerId: string, page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const [reviews, total] = await Promise.all([
      this.prisma.review.findMany({
        where: { rateeId: providerId },
        include: { rater: { include: { profile: true } } },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.review.count({ where: { rateeId: providerId } }),
    ]);

    const breakdown = await this.prisma.review.groupBy({
      by: ['score'],
      where: { rateeId: providerId },
      _count: { id: true },
    });

    return { reviews, total, breakdown };
  }
}
