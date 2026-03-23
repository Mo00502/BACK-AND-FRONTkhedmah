import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { v4 as uuidv4 } from 'uuid';
import { REFERRAL_REWARD_SAR } from '../../common/constants';

@Injectable()
export class RewardsService {
  constructor(
    private prisma: PrismaService,
    private wallet: WalletService,
    private events: EventEmitter2,
  ) {}

  /** Generate or get referral code for a user */
  async getMyCode(userId: string): Promise<string> {
    const existing = await this.prisma.referral.findFirst({
      where: { referrerId: userId, refereeId: null },
    });
    if (existing) return existing.code;

    const code = userId.slice(0, 6).toUpperCase() + Math.floor(1000 + Math.random() * 9000);
    await this.prisma.referral.create({
      data: { referrerId: userId, code, rewardAmount: REFERRAL_REWARD_SAR },
    });
    return code;
  }

  /** Apply referral code at signup */
  async applyCode(refereeId: string, code: string) {
    const referral = await this.prisma.referral.findFirst({
      where: { code, refereeId: null },
    });

    if (!referral) throw new NotFoundException('Invalid or already-used referral code');
    if (referral.referrerId === refereeId) throw new BadRequestException('Cannot refer yourself');

    // Atomic: use updateMany with refereeId: null guard to prevent concurrent double-credit
    const { count } = await this.prisma.referral.updateMany({
      where: { id: referral.id, refereeId: null },
      data: { refereeId, rewardPaid: true },
    });
    if (count === 0) throw new BadRequestException('Referral code was just used by another signup');

    // Credit both wallets (only reached by the one caller that won the race).
    // wallet.creditReferralReward() already emits 'referral.rewarded' — do NOT emit here.
    await this.wallet.creditReferralReward(
      referral.referrerId,
      refereeId,
      Number(referral.rewardAmount),
    );

    return { ok: true, reward: referral.rewardAmount };
  }

  async myReferrals(userId: string) {
    const [code, referrals] = await Promise.all([
      this.getMyCode(userId),
      this.prisma.referral.findMany({
        where: { referrerId: userId, refereeId: { not: null } },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    const totalEarned = referrals
      .filter((r) => r.rewardPaid)
      .reduce((sum, r) => sum + Number(r.rewardAmount), 0);

    return { code, referrals, totalEarned, count: referrals.length };
  }
}
