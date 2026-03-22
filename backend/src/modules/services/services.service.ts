import { Injectable, NotFoundException } from '@nestjs/common';
import { Cache } from 'cache-manager';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Inject } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PaginationDto, paginate } from '../../common/dto/pagination.dto';

@Injectable()
export class ServicesService {
  constructor(
    private prisma: PrismaService,
    @Inject(CACHE_MANAGER) private cache: Cache,
  ) {}

  async findAllCategories() {
    const cacheKey = 'services:categories';
    const cached = await this.cache.get(cacheKey);
    if (cached) return cached;

    const categories = await this.prisma.serviceCategory.findMany({
      include: { services: { where: { active: true }, orderBy: { sortOrder: 'asc' } } },
      orderBy: { sortOrder: 'asc' },
    });

    await this.cache.set(cacheKey, categories, 3_600_000); // 1 hour
    return categories;
  }

  async findAll(dto: PaginationDto & { categoryId?: string }) {
    const where: any = { active: true };
    if (dto.categoryId) where.categoryId = dto.categoryId;
    if (dto.search) {
      where.OR = [
        { nameAr: { contains: dto.search, mode: 'insensitive' } },
        { nameEn: { contains: dto.search, mode: 'insensitive' } },
      ];
    }

    const [services, total] = await Promise.all([
      this.prisma.service.findMany({
        where,
        include: { category: true },
        skip: dto.skip,
        take: dto.limit,
        orderBy: { sortOrder: 'asc' },
      }),
      this.prisma.service.count({ where }),
    ]);

    return paginate(services, total, dto);
  }

  async findById(id: string) {
    const service = await this.prisma.service.findUnique({
      where: { id },
      include: { category: true },
    });
    if (!service) throw new NotFoundException('Service not found');
    return service;
  }

  async findProvidersByService(serviceId: string, dto: PaginationDto & { city?: string }) {
    await this.findById(serviceId);

    const where: any = {
      serviceId,
      provider: {
        user: {
          status: 'ACTIVE',
          deletedAt: null,
          ...(dto.city ? { profile: { city: dto.city } } : {}),
        },
      },
    };

    const [skills, total] = await Promise.all([
      this.prisma.providerSkill.findMany({
        where,
        include: {
          provider: {
            include: {
              user: { include: { profile: true } },
              availability: true,
            },
          },
        },
        skip: dto.skip,
        take: dto.limit,
        orderBy: { provider: { ratingAvg: 'desc' } },
      }),
      this.prisma.providerSkill.count({ where }),
    ]);

    return paginate(skills, total, dto);
  }
}
