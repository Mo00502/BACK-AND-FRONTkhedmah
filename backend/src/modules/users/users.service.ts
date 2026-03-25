import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { PaginationDto, paginate } from '../../common/dto/pagination.dto';
import { UserRole, UserStatus } from '@prisma/client';

// Fields that must never leave the DB layer
const SAFE_USER_SELECT = {
  id: true,
  email: true,
  username: true,
  phone: true,
  role: true,
  status: true,
  suspended: true,
  suspendedReason: true,
  emailVerified: true,
  emailVerifiedAt: true,
  lastLoginAt: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
  // passwordHash, lastLoginIp, refreshTokens — intentionally excluded
} as const;

@Injectable()
export class UsersService {
  constructor(
    private prisma: PrismaService,
    private events: EventEmitter2,
  ) {}

  async findAll(dto: PaginationDto) {
    const where = dto.search
      ? {
          OR: [
            { email: { contains: dto.search, mode: 'insensitive' as const } },
            { username: { contains: dto.search, mode: 'insensitive' as const } },
            { phone: { contains: dto.search } },
            { profile: { nameAr: { contains: dto.search, mode: 'insensitive' as const } } },
            { profile: { nameEn: { contains: dto.search, mode: 'insensitive' as const } } },
          ],
          deletedAt: null,
        }
      : { deletedAt: null };

    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        select: { ...SAFE_USER_SELECT, profile: true, providerProfile: true },
        skip: dto.skip,
        take: dto.limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.user.count({ where }),
    ]);

    return paginate(users, total, dto);
  }

  async findById(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id, deletedAt: null },
      select: {
        ...SAFE_USER_SELECT,
        profile: true,
        providerProfile: {
          include: { skills: { include: { service: true } }, availability: true },
        },
      },
    });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    await this.findById(userId);
    const safeData = {
      ...(dto.nameAr !== undefined && { nameAr: dto.nameAr }),
      ...(dto.nameEn !== undefined && { nameEn: dto.nameEn }),
      ...(dto.gender !== undefined && { gender: dto.gender }),
      ...(dto.langPref !== undefined && { langPref: dto.langPref }),
      ...(dto.city !== undefined && { city: dto.city }),
      ...(dto.avatarUrl !== undefined && { avatarUrl: dto.avatarUrl }),
      ...(dto.bio !== undefined && { bio: dto.bio }),
    };
    return this.prisma.userProfile.upsert({
      where: { userId },
      update: safeData,
      create: { userId, ...safeData },
    });
  }

  async suspend(adminId: string, targetId: string, reason?: string) {
    if (adminId === targetId) {
      throw new ForbiddenException('Cannot suspend yourself');
    }
    const target = await this.findById(targetId);
    if (target.role === UserRole.SUPER_ADMIN) {
      throw new ForbiddenException('Cannot suspend a SUPER_ADMIN');
    }
    // Set BOTH the status enum AND the suspended boolean so all guards agree
    const updated = await this.prisma.user.update({
      where: { id: targetId },
      data: { status: UserStatus.SUSPENDED, suspended: true, suspendedReason: reason ?? null },
    });
    this.events.emit('admin.user_suspended', {
      targetUserId: targetId,
      adminId,
      reason: reason ?? '',
    });
    return updated;
  }

  async ban(adminId: string, targetId: string) {
    const target = await this.findById(targetId);
    if (target.role === UserRole.SUPER_ADMIN) {
      throw new ForbiddenException('Cannot ban a SUPER_ADMIN');
    }
    const updated = await this.prisma.user.update({
      where: { id: targetId },
      data: { status: UserStatus.BANNED },
    });
    this.events.emit('admin.user_banned', { targetUserId: targetId, adminId });
    return updated;
  }

  async softDelete(userId: string) {
    return this.prisma.user.update({
      where: { id: userId },
      data: { deletedAt: new Date() },
    });
  }

  /**
   * Self-delete: user requests account closure.
   * Revokes all sessions and soft-deletes the account.
   * Irreversible — data is preserved for legal/financial audit.
   */
  async selfDelete(userId: string) {
    await this.prisma.$transaction([
      this.prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
      this.prisma.user.update({
        where: { id: userId },
        data: { deletedAt: new Date() },
      }),
    ]);
    return { message: 'Account scheduled for deletion.' };
  }

  async getMyStats(userId: string) {
    const [totalRequests, completed, totalSpent, providerProfile] = await Promise.all([
      this.prisma.serviceRequest.count({ where: { customerId: userId } }),
      this.prisma.serviceRequest.count({ where: { customerId: userId, status: 'COMPLETED' } }),
      this.prisma.payment.aggregate({
        where: { request: { customerId: userId }, status: 'PAID' },
        _sum: { amount: true },
      }),
      this.prisma.providerProfile.findUnique({ where: { userId } }),
    ]);

    return {
      totalRequests,
      completedRequests: completed,
      totalSpent: Number(totalSpent._sum.amount ?? 0),
      ratingAvg: providerProfile ? Number(providerProfile.ratingAvg) || null : null,
      completedJobs: providerProfile?.completedJobs || null,
    };
  }
}
