import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

export interface CreatePromoDto {
  code: string;
  type: 'PERCENT' | 'FIXED';
  value: number; // % off or SAR off
  minOrderAmount?: number;
  maxDiscountAmount?: number;
  usageLimit?: number; // total redemptions allowed (null = unlimited)
  perUserLimit?: number; // per-user redemptions (default 1)
  expiresAt?: Date;
  serviceIds?: string[]; // restrict to specific services (null = all)
  newUsersOnly?: boolean;
  description?: string;
}

@Injectable()
export class PromotionsService {
  constructor(private prisma: PrismaService) {}

  // ── Admin: create promo code ───────────────────────────────────────────────
  async createPromo(dto: CreatePromoDto) {
    const existing = await this.prisma.promoCode.findUnique({ where: { code: dto.code } });
    if (existing) throw new ConflictException('Promo code already exists');

    return this.prisma.promoCode.create({
      data: {
        code: dto.code.toUpperCase(),
        type: dto.type,
        value: dto.value,
        minOrderAmount: dto.minOrderAmount ?? 0,
        maxDiscountAmount: dto.maxDiscountAmount,
        usageLimit: dto.usageLimit,
        perUserLimit: dto.perUserLimit ?? 1,
        expiresAt: dto.expiresAt,
        newUsersOnly: dto.newUsersOnly ?? false,
        description: dto.description,
        active: true,
        usedCount: 0,
      },
    });
  }

  // ── Validate + calculate discount (does NOT apply) ─────────────────────────
  async validateCode(userId: string, code: string, orderAmount: number, serviceId?: string) {
    const promo = await this.prisma.promoCode.findUnique({ where: { code: code.toUpperCase() } });
    if (!promo || !promo.active) throw new NotFoundException('Promo code not found or inactive');

    if (promo.expiresAt && promo.expiresAt < new Date()) {
      throw new BadRequestException('Promo code has expired');
    }
    if (promo.usageLimit && promo.usedCount >= promo.usageLimit) {
      throw new BadRequestException('Promo code usage limit reached');
    }
    if (orderAmount < Number(promo.minOrderAmount)) {
      throw new BadRequestException(`Minimum order amount is SAR ${promo.minOrderAmount}`);
    }

    // Per-user limit check
    const userUsageCount = await this.prisma.promoRedemption.count({
      where: { promoId: promo.id, userId },
    });
    if (userUsageCount >= promo.perUserLimit) {
      throw new BadRequestException('You have already used this promo code');
    }

    // New-users-only check
    if (promo.newUsersOnly) {
      const requestCount = await this.prisma.serviceRequest.count({
        where: { customerId: userId, status: 'COMPLETED' },
      });
      if (requestCount > 0) throw new BadRequestException('This code is for new customers only');
    }

    // Service restriction
    if (promo.serviceIds?.length && serviceId && !promo.serviceIds.includes(serviceId)) {
      throw new BadRequestException('This promo code is not valid for this service');
    }

    const discount = this._calcDiscount(
      promo.type,
      Number(promo.value),
      orderAmount,
      Number(promo.maxDiscountAmount),
    );

    return {
      valid: true,
      promoId: promo.id,
      code: promo.code,
      discountType: promo.type,
      discountValue: promo.value,
      discountAmount: discount,
      finalAmount: +(orderAmount - discount).toFixed(2),
      description: promo.description,
    };
  }

  // ── Apply a validated promo (call after payment confirmed) ─────────────────
  async redeemCode(userId: string, promoId: string, requestId: string, discountAmount: number) {
    await this.prisma.$transaction(async (tx) => {
      const promo = await tx.promoCode.findUnique({ where: { id: promoId } });
      if (!promo || !promo.active) throw new NotFoundException('Promo not found or inactive');

      // Re-check per-user limit inside the transaction to prevent concurrent double-redemption
      const userUsageCount = await tx.promoRedemption.count({ where: { promoId, userId } });
      if (userUsageCount >= promo.perUserLimit) {
        throw new BadRequestException('You have already used this promo code');
      }

      // Re-check global usage limit atomically
      if (promo.usageLimit && promo.usedCount >= promo.usageLimit) {
        throw new BadRequestException('Promo code usage limit reached');
      }

      await tx.promoRedemption.create({
        data: { promoId, userId, requestId, discountAmount },
      });
      await tx.promoCode.update({
        where: { id: promoId },
        data: { usedCount: { increment: 1 } },
      });
    });

    return { message: 'Promo applied', discountAmount };
  }

  // ── Admin: list all promos ─────────────────────────────────────────────────
  async listAll(activeOnly = true) {
    return this.prisma.promoCode.findMany({
      where: activeOnly ? { active: true } : {},
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { redemptions: true } } },
    });
  }

  // ── Admin: deactivate promo ────────────────────────────────────────────────
  async deactivate(promoId: string) {
    return this.prisma.promoCode.update({
      where: { id: promoId },
      data: { active: false },
    });
  }

  // ── Admin: promo performance stats ────────────────────────────────────────
  async getStats(promoId: string) {
    const promo = await this.prisma.promoCode.findUnique({
      where: { id: promoId },
      include: {
        _count: { select: { redemptions: true } },
        redemptions: {
          select: { discountAmount: true },
          orderBy: { createdAt: 'desc' },
        },
      },
    });
    if (!promo) throw new NotFoundException('Promo not found');

    const totalDiscount = promo.redemptions.reduce((s, r) => s + Number(r.discountAmount), 0);
    return { promo, totalRedemptions: promo._count.redemptions, totalDiscountGiven: totalDiscount };
  }

  // ── Private helpers ────────────────────────────────────────────────────────
  private _calcDiscount(
    type: string,
    value: number,
    orderAmount: number,
    maxDiscountAmount?: number,
  ): number {
    let discount = type === 'PERCENT' ? (orderAmount * value) / 100 : value;

    if (maxDiscountAmount) discount = Math.min(discount, maxDiscountAmount);
    return +Math.min(discount, orderAmount).toFixed(2);
  }
}
