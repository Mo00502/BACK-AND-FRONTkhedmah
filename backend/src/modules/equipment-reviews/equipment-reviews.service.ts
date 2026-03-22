import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { EventEmitter2 } from '@nestjs/event-emitter';

@Injectable()
export class EquipmentReviewsService {
  constructor(
    private prisma: PrismaService,
    private events: EventEmitter2,
  ) {}

  async submit(
    rentalId: string,
    userId: string,
    data: { score: number; comment?: string; photos?: string[] },
  ) {
    const rental = await this.prisma.equipmentRental.findUnique({ where: { id: rentalId } });
    if (!rental) throw new NotFoundException('Rental not found');
    if (rental.renterId !== userId) throw new ForbiddenException();
    if (rental.status !== 'COMPLETED')
      throw new BadRequestException('Can only review completed rentals');

    const existingReview = await this.prisma.equipmentReview.findFirst({ where: { rentalId } });
    if (existingReview) throw new BadRequestException('You have already reviewed this rental');

    const review = await this.prisma.equipmentReview.create({
      data: {
        rentalId,
        equipmentId: rental.equipmentId,
        reviewerId: userId,
        score: data.score,
        comment: data.comment,
        photos: data.photos || [],
      },
    });

    // Recalculate equipment rating
    const agg = await this.prisma.equipmentReview.aggregate({
      where: { equipmentId: rental.equipmentId },
      _avg: { score: true },
      _count: { score: true },
    });

    await this.prisma.equipment.update({
      where: { id: rental.equipmentId },
      data: {
        rating: agg._avg.score ?? 0,
        reviewCount: agg._count.score,
      },
    });

    this.events.emit('equipment.reviewed', { rentalId, score: data.score });
    return review;
  }

  async listForEquipment(equipmentId: string, page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const [reviews, total] = await Promise.all([
      this.prisma.equipmentReview.findMany({
        where: { equipmentId },
        include: {
          reviewer: { select: { profile: { select: { nameAr: true, avatarUrl: true } } } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.equipmentReview.count({ where: { equipmentId } }),
    ]);
    return { reviews, total, page, limit };
  }
}
