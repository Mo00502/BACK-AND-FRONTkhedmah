import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

export interface SearchFilters {
  q: string;
  city?: string;
  region?: string;
  minPrice?: number;
  maxPrice?: number;
  category?: string;
  page?: number;
  limit?: number;
}

@Injectable()
export class SearchService {
  constructor(private prisma: PrismaService) {}

  // ── Unified search across all verticals ────────────────────────────────
  async searchAll(filters: SearchFilters) {
    const { q } = filters;
    const [providers, services, tenders, equipment] = await Promise.all([
      this.searchProviders(filters),
      this.searchServices(q),
      this.searchTenders(filters),
      this.searchEquipment(filters),
    ]);
    return { query: q, providers, services, tenders, equipment };
  }

  // ── Providers full-text search ─────────────────────────────────────────
  async searchProviders(filters: SearchFilters) {
    const { q, city, page = 1, limit = 10 } = filters;
    const skip = (page - 1) * limit;

    // Use Prisma's built-in contains for case-insensitive search
    const where: any = {
      verificationStatus: 'APPROVED',
      user: { status: 'ACTIVE', deletedAt: null, suspended: false },
      OR: [
        { bio: { contains: q, mode: 'insensitive' } },
        { user: { profile: { nameAr: { contains: q, mode: 'insensitive' } } } },
        { user: { profile: { nameEn: { contains: q, mode: 'insensitive' } } } },
        { user: { username: { contains: q, mode: 'insensitive' } } },
        {
          skills: {
            some: {
              service: {
                OR: [
                  { nameAr: { contains: q, mode: 'insensitive' } },
                  { nameEn: { contains: q, mode: 'insensitive' } },
                ],
              },
            },
          },
        },
      ],
    };
    if (city) {
      where.user = {
        status: 'ACTIVE',
        suspended: false,
        deletedAt: null,
        profile: { city },
      };
    }

    const [items, total] = await Promise.all([
      this.prisma.providerProfile.findMany({
        where,
        skip,
        take: limit,
        orderBy: [{ ratingAvg: 'desc' }, { completedJobs: 'desc' }],
        include: {
          user: { include: { profile: true } },
          skills: { include: { service: true } },
        },
      }),
      this.prisma.providerProfile.count({ where }),
    ]);
    return { items, total, page, pages: Math.ceil(total / limit) };
  }

  // ── Service catalog search ─────────────────────────────────────────────
  async searchServices(q: string) {
    return this.prisma.service.findMany({
      where: {
        active: true,
        OR: [
          { nameAr: { contains: q, mode: 'insensitive' } },
          { nameEn: { contains: q, mode: 'insensitive' } },
          { category: { nameAr: { contains: q, mode: 'insensitive' } } },
          { category: { nameEn: { contains: q, mode: 'insensitive' } } },
        ],
      },
      orderBy: { nameAr: 'asc' },
      take: 10,
    });
  }

  // ── Tender search ──────────────────────────────────────────────────────
  async searchTenders(filters: SearchFilters) {
    const { q, region, minPrice, maxPrice, page = 1, limit = 10 } = filters;
    const skip = (page - 1) * limit;

    const where: any = {
      status: 'OPEN',
      OR: [
        { title: { contains: q, mode: 'insensitive' } },
        { description: { contains: q, mode: 'insensitive' } },
        { region: { contains: q, mode: 'insensitive' } },
      ],
    };
    if (region) where.region = { contains: region, mode: 'insensitive' };
    if (minPrice) where.budgetMin = { gte: minPrice };
    if (maxPrice) where.budgetMax = { lte: maxPrice };

    const [items, total] = await Promise.all([
      this.prisma.tender.findMany({
        where,
        skip,
        take: limit,
        orderBy: { deadline: 'asc' },
        include: {
          company: { select: { nameAr: true, nameEn: true, region: true } as any },
          // Intentionally NO _count.bids — exposing bid count violates bid privacy rules
        },
      }),
      this.prisma.tender.count({ where }),
    ]);
    return { items, total, page, pages: Math.ceil(total / limit) };
  }

  // ── Equipment search ───────────────────────────────────────────────────
  async searchEquipment(filters: SearchFilters) {
    const { q, region, category, minPrice, maxPrice, page = 1, limit = 10 } = filters;
    const skip = (page - 1) * limit;

    const where: any = {
      status: 'ACTIVE',
      isAvailable: true,
      OR: [
        { name: { contains: q, mode: 'insensitive' } },
        { description: { contains: q, mode: 'insensitive' } },
        { brand: { contains: q, mode: 'insensitive' } },
      ],
    };
    if (region) where.region = region;
    if (category) where.category = category;
    if (minPrice) where.dayPrice = { ...where.dayPrice, gte: minPrice };
    if (maxPrice) where.dayPrice = { ...where.dayPrice, lte: maxPrice };

    const [items, total] = await Promise.all([
      this.prisma.equipment.findMany({
        where,
        skip,
        take: limit,
        orderBy: [{ rating: 'desc' }, { rentalCount: 'desc' }],
        include: { owner: { include: { profile: true } } },
      }),
      this.prisma.equipment.count({ where }),
    ]);
    return { items, total, page, pages: Math.ceil(total / limit) };
  }

  // ── Autocomplete suggestions ───────────────────────────────────────────
  async autocomplete(q: string) {
    if (!q || q.length < 2) return [];

    const [services, categories, locations] = await Promise.all([
      this.prisma.service.findMany({
        where: {
          active: true,
          OR: [
            { nameAr: { startsWith: q, mode: 'insensitive' } },
            { nameEn: { startsWith: q, mode: 'insensitive' } },
          ],
        },
        select: { nameAr: true, nameEn: true },
        take: 5,
      }),
      this.prisma.serviceCategory.findMany({
        where: {
          OR: [
            { nameAr: { startsWith: q, mode: 'insensitive' } },
            { nameEn: { startsWith: q, mode: 'insensitive' } },
          ],
        },
        select: { nameAr: true, nameEn: true, id: true },
        take: 3,
      }),
      this.prisma.userProfile.findMany({
        where: { city: { startsWith: q, mode: 'insensitive' } },
        distinct: ['city'],
        select: { city: true },
        take: 3,
      }),
    ]);

    return [
      ...services.map((s) => ({ type: 'service', label: s.nameAr })),
      ...categories.map((c) => ({
        type: 'category',
        label: c.nameAr,
        labelEn: c.nameEn,
        id: c.id,
      })),
      ...locations.map((l) => ({ type: 'city', label: l.city })),
    ];
  }
}
