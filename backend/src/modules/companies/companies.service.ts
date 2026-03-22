import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PaginationDto, paginate } from '../../common/dto/pagination.dto';
import { CreateCompanyDto, UpdateCompanyDto } from './dto/company.dto';

@Injectable()
export class CompaniesService {
  constructor(private prisma: PrismaService) {}

  async findAll(dto: PaginationDto & { city?: string; verified?: boolean }) {
    const where: any = {};
    if (dto.city) where.city = { contains: dto.city, mode: 'insensitive' };
    if (dto.verified !== undefined) where.verified = dto.verified;

    const [companies, total] = await Promise.all([
      this.prisma.company.findMany({
        where,
        select: {
          id: true,
          nameAr: true,
          nameEn: true,
          logoUrl: true,
          city: true,
          verified: true,
          crNumber: true,
          _count: { select: { tenders: true } },
        },
        skip: dto.skip,
        take: dto.limit,
        orderBy: { nameAr: 'asc' },
      }),
      this.prisma.company.count({ where }),
    ]);

    return paginate(companies, total, dto);
  }

  async getById(id: string) {
    const company = await this.prisma.company.findUnique({
      where: { id },
      include: {
        tenders: {
          where: { status: 'OPEN' },
          take: 5,
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            title: true,
            budgetMin: true,
            budgetMax: true,
            deadline: true,
            status: true,
          },
        },
        owner: { include: { profile: true } },
      },
    });
    if (!company) throw new NotFoundException('Company not found');
    return company;
  }

  async getMyCompany(userId: string) {
    const company = await this.prisma.company.findFirst({
      where: { ownerId: userId },
      include: {
        tenders: { orderBy: { createdAt: 'desc' }, take: 10 },
        _count: { select: { tenders: true, bids: true } },
      },
    });
    if (!company) throw new NotFoundException('No company profile found. Please create one first.');
    return company;
  }

  async create(userId: string, dto: CreateCompanyDto) {
    const existing = await this.prisma.company.findUnique({ where: { crNumber: dto.crNumber } });
    if (existing) throw new ConflictException('A company with this CR number already exists');

    return this.prisma.company.create({
      data: { ownerId: userId, ...dto } as any,
    });
  }

  async update(id: string, userId: string, dto: UpdateCompanyDto) {
    const company = await this.prisma.company.findUnique({ where: { id } });
    if (!company) throw new NotFoundException('Company not found');
    if (company.ownerId !== userId)
      throw new ForbiddenException('Only the company owner can update this profile');

    if (dto.crNumber && dto.crNumber !== company.crNumber) {
      const conflict = await this.prisma.company.findUnique({ where: { crNumber: dto.crNumber } });
      if (conflict) throw new ConflictException('CR number already registered to another company');
    }

    return this.prisma.company.update({ where: { id }, data: dto });
  }

  async delete(id: string, userId: string) {
    const company = await this.prisma.company.findUnique({ where: { id } });
    if (!company) throw new NotFoundException('Company not found');
    if (company.ownerId !== userId)
      throw new ForbiddenException('Only the company owner can delete this profile');

    const activeTenders = await this.prisma.tender.count({
      where: { companyId: id, status: { in: ['OPEN', 'UNDER_REVIEW'] } },
    });
    if (activeTenders > 0) {
      throw new ConflictException(
        'Cannot delete company with active tenders. Close or cancel them first.',
      );
    }

    await this.prisma.company.delete({ where: { id } });
    return { message: 'Company deleted' };
  }
}
