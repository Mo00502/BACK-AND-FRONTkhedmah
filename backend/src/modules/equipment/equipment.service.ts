import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { EquipmentVisibility, EquipmentInquiryStatus } from '@prisma/client';
import { PaginationDto, paginate } from '../../common/dto/pagination.dto';

// Fields safe to show in marketplace listings (no internal bookkeeping fields)
const LISTING_SELECT = {
  id: true,
  name: true,
  category: true,
  brand: true,
  model: true,
  year: true,
  capacity: true,
  description: true,
  imageUrls: true,
  emoji: true,
  region: true,
  city: true,
  hourPrice: true,
  dayPrice: true,
  weekPrice: true,
  monthPrice: true,
  hasOperator: true,
  hasDelivery: true,
  deliveryCost: true,
  deposit: true,
  minRental: true,
  isAvailable: true,
  status: true,
  rating: true,
  reviewCount: true,
  rentalCount: true,
  createdAt: true,
};

@Injectable()
export class EquipmentService {
  constructor(
    private prisma: PrismaService,
    private events: EventEmitter2,
  ) {}

  // ── Marketplace browse ────────────────────────────────────────────────────

  /**
   * Global marketplace feed — shows active, public listings from all providers.
   * Includes a slim provider card (name, avatar, city, rating) on each listing
   * so users can open the provider's storefront from any listing.
   *
   * Supports filtering by category, region, city, rental type, availability,
   * price range, and full-text keyword (matches name, description, brand, model).
   */
  async search(
    filters: {
      category?: string;
      region?: string;
      city?: string;
      q?: string;
      available?: boolean;
      rentalType?: 'hour' | 'day' | 'week' | 'month';
      minPrice?: number;
      maxPrice?: number;
    } = {},
    pagination: PaginationDto = new PaginationDto(),
  ) {
    const { category, region, city, q, available, rentalType, minPrice, maxPrice } = filters;

    // Price range filter targets the selected rental type column (or dayPrice as default)
    const priceField = rentalType ? `${rentalType}Price` : 'dayPrice';
    const priceFilter =
      minPrice !== undefined || maxPrice !== undefined
        ? {
            [priceField]: {
              ...(minPrice !== undefined ? { gte: minPrice } : {}),
              ...(maxPrice !== undefined ? { lte: maxPrice } : {}),
            },
          }
        : {};

    const where: any = {
      status: 'ACTIVE',
      visibility: EquipmentVisibility.PUBLIC,
      category: (category as any) || undefined,
      region: region || undefined,
      city: city || undefined,
      isAvailable: available ?? undefined,
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: 'insensitive' } },
              { description: { contains: q, mode: 'insensitive' } },
              { brand: { contains: q, mode: 'insensitive' } },
              { model: { contains: q, mode: 'insensitive' } },
            ],
          }
        : {}),
      ...priceFilter,
    };

    const [items, total] = await Promise.all([
      this.prisma.equipment.findMany({
        where,
        select: {
          ...LISTING_SELECT,
          owner: {
            select: {
              id: true,
              profile: { select: { nameAr: true, nameEn: true, avatarUrl: true, city: true } },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: pagination.skip,
        take: pagination.limit,
      }),
      this.prisma.equipment.count({ where }),
    ]);
    return paginate(items, total, pagination);
  }

  /**
   * Provider storefront — returns the provider's public profile plus ALL their
   * active equipment listings. This is Layer 2 of the dual-discovery model.
   */
  async getProviderProfile(ownerId: string) {
    // Load provider's public profile
    const user = await this.prisma.user.findUnique({
      where: { id: ownerId },
      select: {
        id: true,
        profile: { select: { nameAr: true, nameEn: true, avatarUrl: true, bio: true, city: true } },
        providerProfile: { select: { ratingAvg: true, ratingCount: true, completedJobs: true } },
      },
    });
    if (!user) throw new NotFoundException('Provider not found');

    const listings = await this.prisma.equipment.findMany({
      where: { ownerId, status: 'ACTIVE', visibility: EquipmentVisibility.PUBLIC },
      select: LISTING_SELECT,
      orderBy: { createdAt: 'desc' },
    });

    return { provider: user, listings };
  }

  async get(id: string) {
    const eq = await this.prisma.equipment.findUnique({
      where: { id },
      include: {
        owner: {
          select: {
            id: true,
            profile: {
              select: { nameAr: true, nameEn: true, avatarUrl: true, city: true, bio: true },
            },
          },
        },
        rentals: {
          where: { status: { in: ['PENDING', 'CONFIRMED', 'ACTIVE'] } },
          select: { id: true, startDate: true, endDate: true, status: true },
        },
      },
    });
    if (!eq) throw new NotFoundException('Equipment not found');
    return eq;
  }

  async create(userId: string, data: Record<string, any>) {
    return this.prisma.equipment.create({
      data: { ownerId: userId, status: 'PENDING', isAvailable: true, ...data } as any,
    });
  }

  async update(id: string, userId: string, data: Record<string, any>) {
    const eq = await this.prisma.equipment.findUnique({ where: { id } });
    if (!eq) throw new NotFoundException('Equipment not found');
    if (eq.ownerId !== userId) throw new ForbiddenException();

    // Allowlist: only provider-editable fields. Fields like ownerId, rating,
    // rentalCount, reviewCount, status are excluded to prevent injection.
    const {
      name, description, category, brand, model, year, capacity,
      imageUrls, emoji, region, city,
      hourPrice, dayPrice, weekPrice, monthPrice,
      hasOperator, hasDelivery, deliveryCost, deposit,
      minRental, isAvailable,
    } = data;

    const safeData = Object.fromEntries(
      Object.entries({
        name, description, category, brand, model, year, capacity,
        imageUrls, emoji, region, city,
        hourPrice, dayPrice, weekPrice, monthPrice,
        hasOperator, hasDelivery, deliveryCost, deposit,
        minRental, isAvailable,
      }).filter(([, v]) => v !== undefined),
    );

    return this.prisma.equipment.update({ where: { id }, data: safeData });
  }

  async remove(id: string, userId: string) {
    const eq = await this.prisma.equipment.findUnique({ where: { id } });
    if (!eq) throw new NotFoundException();
    if (eq.ownerId !== userId) throw new ForbiddenException();
    return this.prisma.equipment.update({ where: { id }, data: { status: 'ARCHIVED' } });
  }

  async listMine(userId: string, page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const where = { ownerId: userId };
    const [items, total] = await Promise.all([
      this.prisma.equipment.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.equipment.count({ where }),
    ]);
    return { items, total, page, pages: Math.ceil(total / limit) };
  }

  // ── Inquiries ─────────────────────────────────────────────────────────────

  /**
   * Customer sends an inquiry to the equipment owner about a listing.
   * Owner cannot send inquiries about their own equipment.
   */
  async submitInquiry(
    equipmentId: string,
    userId: string,
    data: { message: string; phone?: string },
  ) {
    const eq = await this.prisma.equipment.findUnique({ where: { id: equipmentId } });
    if (!eq) throw new NotFoundException('Equipment not found');
    if (eq.ownerId === userId)
      throw new ForbiddenException('You cannot send an inquiry about your own equipment');
    if (eq.status !== 'ACTIVE') throw new BadRequestException('This listing is not available');

    const inquiry = await this.prisma.equipmentInquiry.create({
      data: { equipmentId, fromUserId: userId, message: data.message, phone: data.phone },
    });

    this.events.emit('equipment.inquiry_received', {
      equipmentId,
      ownerId: eq.ownerId,
      inquiryId: inquiry.id,
    });
    return inquiry;
  }

  /**
   * Equipment owner views all inquiries for one of their listings.
   */
  async listInquiries(equipmentId: string, userId: string, page = 1, limit = 20) {
    const eq = await this.prisma.equipment.findUnique({ where: { id: equipmentId } });
    if (!eq) throw new NotFoundException('Equipment not found');
    if (eq.ownerId !== userId)
      throw new ForbiddenException('Only the equipment owner can view inquiries');

    const skip = (page - 1) * limit;
    const where = { equipmentId };
    const [items, total] = await Promise.all([
      this.prisma.equipmentInquiry.findMany({
        where,
        include: {
          fromUser: {
            select: {
              id: true,
              profile: { select: { nameAr: true, nameEn: true, avatarUrl: true } },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.equipmentInquiry.count({ where }),
    ]);
    return { items, total, page, pages: Math.ceil(total / limit) };
  }

  /**
   * Customer sees all inquiries they have sent.
   */
  async myInquiries(userId: string, page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const where = { fromUserId: userId };
    const [items, total] = await Promise.all([
      this.prisma.equipmentInquiry.findMany({
        where,
        include: {
          equipment: {
            select: { id: true, name: true, category: true, region: true, imageUrls: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.equipmentInquiry.count({ where }),
    ]);
    return { items, total, page, pages: Math.ceil(total / limit) };
  }

  /**
   * Mark an inquiry as replied/closed (owner only).
   */
  async updateInquiryStatus(inquiryId: string, userId: string, status: EquipmentInquiryStatus) {
    const inquiry = await this.prisma.equipmentInquiry.findUnique({
      where: { id: inquiryId },
      include: { equipment: { select: { ownerId: true } } },
    });
    if (!inquiry) throw new NotFoundException('Inquiry not found');
    if (inquiry.equipment.ownerId !== userId)
      throw new ForbiddenException('Only the equipment owner can update inquiry status');

    return this.prisma.equipmentInquiry.update({
      where: { id: inquiryId },
      data: {
        status,
        ...(status === 'REPLIED' ? { repliedAt: new Date() } : {}),
      },
    });
  }

  // ── Rentals ───────────────────────────────────────────────────────────────

  async createRental(equipmentId: string, userId: string, data: Record<string, any>) {
    const eq = await this.get(equipmentId);
    if (!eq.isAvailable) throw new BadRequestException('Equipment is not available for rental');
    if (eq.status !== 'ACTIVE') throw new BadRequestException('Equipment is not active');
    if (eq.ownerId === userId) throw new ForbiddenException('You cannot rent your own equipment');

    // Atomically mark as unavailable before creating rental — prevents double-booking race
    const rental = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.equipment.updateMany({
        where: { id: equipmentId, isAvailable: true, status: 'ACTIVE' },
        data: { isAvailable: false },
      });
      if (count === 0)
        throw new BadRequestException('Equipment was just booked by another customer');

      return tx.equipmentRental.create({
        data: { equipmentId, renterId: userId, status: 'PENDING', ...data } as any,
      });
    });

    this.events.emit('equipment.booked', {
      equipmentId,
      ownerId: eq.ownerId,
      renterId: userId,
      rentalId: rental.id,
    });
    return rental;
  }

  async updateRentalStatus(id: string, status: string, userId: string) {
    const rental = await this.prisma.equipmentRental.findUnique({
      where: { id },
      include: { equipment: true },
    });
    if (!rental) throw new NotFoundException('Rental not found');

    const isOwner = rental.equipment.ownerId === userId;
    const isRenter = rental.renterId === userId;

    // Only owner can CONFIRM / COMPLETE; only renter (or owner) can CANCEL
    if (status === 'CONFIRMED' || status === 'COMPLETED') {
      if (!isOwner)
        throw new ForbiddenException('Only the equipment owner can confirm or complete rentals');
    } else if (status === 'CANCELLED') {
      if (!isOwner && !isRenter)
        throw new ForbiddenException('Not authorised to cancel this rental');
    } else {
      if (!isOwner)
        throw new ForbiddenException('Only the equipment owner can change rental status');
    }

    const timestamps: Record<string, Date | undefined> = {};
    if (status === 'CONFIRMED') timestamps['confirmedAt'] = new Date();
    if (status === 'COMPLETED') timestamps['completedAt'] = new Date();
    if (status === 'CANCELLED') timestamps['cancelledAt'] = new Date();

    const updated = await this.prisma.equipmentRental.update({
      where: { id },
      data: { status: status as any, ...timestamps },
    });

    if (status === 'COMPLETED') {
      await this.prisma.equipment.update({
        where: { id: rental.equipmentId },
        data: { isAvailable: true, rentalCount: { increment: 1 } },
      });
    } else if (status === 'CANCELLED') {
      await this.prisma.equipment.update({
        where: { id: rental.equipmentId },
        data: { isAvailable: true },
      });
    }

    this.events.emit('equipment.rental.status_changed', { id, status });
    return updated;
  }

  async myRentals(userId: string, page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const where = { renterId: userId };
    const [items, total] = await Promise.all([
      this.prisma.equipmentRental.findMany({
        where,
        include: {
          equipment: {
            select: { id: true, name: true, category: true, region: true, dayPrice: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.equipmentRental.count({ where }),
    ]);
    return { items, total, page, pages: Math.ceil(total / limit) };
  }
}
