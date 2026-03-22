import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Decimal } from '@prisma/client/runtime/library';

@Injectable()
export class WalletService {
  constructor(
    private prisma: PrismaService,
    private events: EventEmitter2,
  ) {}

  async getOrCreate(userId: string) {
    let wallet = await this.prisma.wallet.findUnique({ where: { userId } });
    if (!wallet) {
      wallet = await this.prisma.wallet.create({
        data: { userId, balance: 0, heldBalance: 0 },
      });
    }
    return wallet;
  }

  async getBalance(userId: string) {
    const wallet = await this.getOrCreate(userId);
    return {
      balance: wallet.balance,
      heldBalance: wallet.heldBalance,
      available: new Decimal(wallet.balance).minus(wallet.heldBalance),
    };
  }

  async credit(
    userId: string,
    amount: number,
    description: string,
    refId?: string,
    refType?: string,
  ) {
    const wallet = await this.getOrCreate(userId);
    const newBalance = new Decimal(wallet.balance).plus(amount);

    await this.prisma.$transaction([
      this.prisma.wallet.update({
        where: { id: wallet.id },
        data: { balance: newBalance },
      }),
      this.prisma.walletTransaction.create({
        data: {
          walletId: wallet.id,
          type: 'CREDIT',
          amount,
          balanceAfter: newBalance,
          description,
          refId,
          refType,
        },
      }),
    ]);

    this.events.emit('wallet.credited', { userId, amount, newBalance });
    return { balance: newBalance };
  }

  async debit(
    userId: string,
    amount: number,
    description: string,
    refId?: string,
    refType?: string,
  ) {
    const wallet = await this.getOrCreate(userId);
    const available = new Decimal(wallet.balance).minus(wallet.heldBalance);

    if (available.lessThan(amount)) {
      throw new BadRequestException('Insufficient wallet balance');
    }

    const newBalance = new Decimal(wallet.balance).minus(amount);

    await this.prisma.$transaction([
      this.prisma.wallet.update({
        where: { id: wallet.id },
        data: { balance: newBalance },
      }),
      this.prisma.walletTransaction.create({
        data: {
          walletId: wallet.id,
          type: 'DEBIT',
          amount,
          balanceAfter: newBalance,
          description,
          refId,
          refType,
        },
      }),
    ]);

    this.events.emit('wallet.debited', { userId, amount, newBalance });
    return { balance: newBalance };
  }

  async getTransactions(userId: string, page = 1, limit = 20) {
    const wallet = await this.getOrCreate(userId);
    const skip = (page - 1) * limit;
    const [transactions, total] = await Promise.all([
      this.prisma.walletTransaction.findMany({
        where: { walletId: wallet.id },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.walletTransaction.count({ where: { walletId: wallet.id } }),
    ]);
    return { transactions, total, page, limit };
  }

  async creditReferralReward(referrerId: string, refereeId: string, amount: number) {
    await this.credit(referrerId, amount, 'مكافأة الإحالة', refereeId, 'referral');
    await this.credit(refereeId, amount, 'مكافأة ترحيب', referrerId, 'referral');
    this.events.emit('referral.rewarded', { referrerId, refereeId, amount });
  }

  // ── Withdrawal requests ──────────────────────────────────────────────────

  async requestWithdrawal(
    userId: string,
    amount: number,
    iban: string,
    bankName: string,
    beneficiaryName: string,
    notes?: string,
  ) {
    const MIN_WITHDRAWAL = 50;
    if (amount < MIN_WITHDRAWAL) {
      throw new BadRequestException(`Minimum withdrawal amount is SAR ${MIN_WITHDRAWAL}`);
    }

    const wallet = await this.getOrCreate(userId);
    const available = new Decimal(wallet.balance).minus(wallet.heldBalance);
    if (available.lessThan(amount)) {
      throw new BadRequestException('Insufficient available balance');
    }

    // Hold the amount and create the withdrawal record atomically
    const withdrawal = await this.prisma.$transaction(async (tx) => {
      await tx.wallet.update({
        where: { id: wallet.id },
        data: { heldBalance: new Decimal(wallet.heldBalance).plus(amount) },
      });
      await tx.walletTransaction.create({
        data: {
          walletId: wallet.id,
          type: 'HOLD',
          amount,
          balanceAfter: wallet.balance, // total balance unchanged; only heldBalance increases
          description: 'حجز مبلغ طلب السحب',
          refType: 'withdrawal',
        },
      });
      return tx.withdrawalRequest.create({
        data: { userId, amount, iban, bankName, beneficiaryName, notes },
      });
    });

    this.events.emit('wallet.withdrawal_requested', {
      userId,
      amount,
      withdrawalId: withdrawal.id,
    });
    return withdrawal;
  }

  async getWithdrawals(userId: string, page = 1, limit = 10) {
    const skip = (page - 1) * limit;
    const [items, total] = await Promise.all([
      this.prisma.withdrawalRequest.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.withdrawalRequest.count({ where: { userId } }),
    ]);
    return { items, total, page, limit };
  }

  async adminListWithdrawals(status: string = 'PENDING', page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const [items, total] = await Promise.all([
      this.prisma.withdrawalRequest.findMany({
        where: status === 'ALL' ? {} : { status: status as any },
        orderBy: { createdAt: 'asc' },
        skip,
        take: limit,
        include: { user: { include: { profile: true } } },
      }),
      this.prisma.withdrawalRequest.count({
        where: status === 'ALL' ? {} : { status: status as any },
      }),
    ]);
    return { items, total, page, limit };
  }

  /** Admin: approve and complete withdrawal */
  async approveWithdrawal(withdrawalId: string, adminId: string, adminNote?: string) {
    const wr = await this.prisma.withdrawalRequest.findUnique({
      where: { id: withdrawalId },
      include: { user: true },
    });
    if (!wr) throw new NotFoundException('Withdrawal request not found');
    if (wr.status !== 'PENDING')
      throw new BadRequestException('Only PENDING withdrawals can be approved');

    const wallet = await this.getOrCreate(wr.userId);
    const newBalance = new Decimal(wallet.balance).minus(wr.amount);
    const newHeldBalance = new Decimal(wallet.heldBalance).minus(wr.amount);

    await this.prisma.$transaction([
      this.prisma.wallet.update({
        where: { id: wallet.id },
        data: { balance: newBalance, heldBalance: newHeldBalance },
      }),
      this.prisma.walletTransaction.create({
        data: {
          walletId: wallet.id,
          type: 'DEBIT',
          amount: Number(wr.amount),
          balanceAfter: newBalance,
          description: `سحب للحساب البنكي — ${wr.bankName}`,
          refId: withdrawalId,
          refType: 'withdrawal',
        },
      }),
      this.prisma.withdrawalRequest.update({
        where: { id: withdrawalId },
        data: {
          status: 'COMPLETED',
          processedBy: adminId,
          processedAt: new Date(),
          adminNote,
        },
      }),
    ]);

    this.events.emit('wallet.withdrawal_completed', {
      userId: wr.userId,
      amount: Number(wr.amount),
    });
    return { message: 'Withdrawal approved and completed' };
  }

  /** Admin: reject withdrawal and release hold */
  async rejectWithdrawal(withdrawalId: string, adminId: string, adminNote: string) {
    const wr = await this.prisma.withdrawalRequest.findUnique({ where: { id: withdrawalId } });
    if (!wr) throw new NotFoundException('Withdrawal request not found');
    if (wr.status !== 'PENDING')
      throw new BadRequestException('Only PENDING withdrawals can be rejected');

    const wallet = await this.getOrCreate(wr.userId);

    await this.prisma.$transaction([
      this.prisma.wallet.update({
        where: { id: wallet.id },
        data: { heldBalance: new Decimal(wallet.heldBalance).minus(wr.amount) },
      }),
      this.prisma.walletTransaction.create({
        data: {
          walletId: wallet.id,
          type: 'RELEASE',
          amount: Number(wr.amount),
          balanceAfter: wallet.balance,
          description: 'تحرير مبلغ طلب سحب مرفوض',
          refId: withdrawalId,
          refType: 'withdrawal',
        },
      }),
      this.prisma.withdrawalRequest.update({
        where: { id: withdrawalId },
        data: {
          status: 'REJECTED',
          processedBy: adminId,
          processedAt: new Date(),
          adminNote,
        },
      }),
    ]);

    this.events.emit('wallet.withdrawal_rejected', {
      userId: wr.userId,
      amount: Number(wr.amount),
    });
    return { message: 'Withdrawal rejected and balance released' };
  }
}
