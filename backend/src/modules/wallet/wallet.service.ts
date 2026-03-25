import { Injectable, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Decimal } from '@prisma/client/runtime/library';
import { WalletTxType, WithdrawalStatus } from '@prisma/client';

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
    // Convert Prisma Decimals to plain numbers for JSON serialisation.
    // Returning a Decimal object produces unexpected output (object, not number) in HTTP responses.
    return {
      balance: Number(wallet.balance),
      heldBalance: Number(wallet.heldBalance),
      available: Number(new Decimal(wallet.balance).minus(wallet.heldBalance)),
    };
  }

  async credit(
    userId: string,
    amount: number,
    description: string,
    refId?: string,
    refType?: string,
    idempotencyKey?: string,
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
          type: WalletTxType.CREDIT,
          amount,
          balanceAfter: newBalance,
          description,
          refId,
          refType,
          ...(idempotencyKey && { idempotencyKey }),
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
          type: WalletTxType.DEBIT,
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
    // Emit separate events so each user gets their own notification
    this.events.emit('referral.credited_referrer', { userId: referrerId, refereeId, amount });
    this.events.emit('referral.credited_referee', { userId: refereeId, referrerId, amount });
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
    // KYC guard: only APPROVED providers may withdraw funds.
    // Prevents PENDING_REVIEW, UNDER_REVIEW, REJECTED, and SUSPENDED providers from
    // draining any balance they may have accumulated before verification completes.
    const providerProfile = await this.prisma.providerProfile.findUnique({
      where: { userId },
      select: { verificationStatus: true, ibanNumber: true, bankName: true },
    });
    if (!providerProfile || providerProfile.verificationStatus !== 'APPROVED') {
      throw new ForbiddenException(
        'يمكن فقط للمزودين المعتمدين طلب السحب — حسابك لم يُعتمد بعد',
      );
    }

    // IBAN integrity: must match what the provider registered during KYC.
    // Prevents withdrawals to unverified bank accounts.
    if (
      providerProfile.ibanNumber &&
      iban.replace(/\s/g, '').toUpperCase() !==
        providerProfile.ibanNumber.replace(/\s/g, '').toUpperCase()
    ) {
      throw new ForbiddenException(
        'رقم الآيبان لا يطابق الحساب البنكي المسجل — يرجى تحديث بياناتك البنكية أولاً',
      );
    }

    // Saudi IBAN format: SA + 22 digits = 24 characters total
    const ibanNorm = iban.replace(/\s/g, '').toUpperCase();
    if (!/^SA\d{22}$/.test(ibanNorm)) {
      throw new BadRequestException('صيغة الآيبان غير صحيحة — يجب أن يبدأ بـ SA ويتكون من 24 خانة');
    }

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
          type: WalletTxType.HOLD,
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
    const validStatuses = Object.values(WithdrawalStatus) as string[];
    const statusFilter =
      status === 'ALL' || !validStatuses.includes(status)
        ? {}
        : { status: status as WithdrawalStatus };
    const [items, total] = await Promise.all([
      this.prisma.withdrawalRequest.findMany({
        where: statusFilter,
        orderBy: { createdAt: 'asc' },
        skip,
        take: limit,
        include: { user: { include: { profile: true } } },
      }),
      this.prisma.withdrawalRequest.count({ where: statusFilter }),
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
    if (!([WithdrawalStatus.PENDING, WithdrawalStatus.PROCESSING] as WithdrawalStatus[]).includes(wr.status))
      throw new BadRequestException('Withdrawal is not in a processable state');

    const wallet = await this.getOrCreate(wr.userId);
    const newBalance = new Decimal(wallet.balance).minus(wr.amount);
    const newHeldBalance = new Decimal(wallet.heldBalance).minus(wr.amount);

    // Debit balance + mark COMPLETED atomically so a crash cannot leave
    // the record stuck in PROCESSING with funds already debited.
    await this.prisma.$transaction(async (tx) => {
      await tx.wallet.update({
        where: { id: wallet.id },
        data: { balance: newBalance, heldBalance: newHeldBalance },
      });
      await tx.walletTransaction.create({
        data: {
          walletId: wallet.id,
          type: WalletTxType.DEBIT,
          amount: Number(wr.amount),
          balanceAfter: newBalance,
          description: `سحب للحساب البنكي — ${wr.bankName}`,
          refId: withdrawalId,
          refType: 'withdrawal',
        },
      });
      await tx.withdrawalRequest.update({
        where: { id: withdrawalId },
        data: {
          status: WithdrawalStatus.COMPLETED,
          processedBy: adminId,
          processedAt: new Date(),
          adminNote,
        },
      });
    });

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
    if (wr.status !== WithdrawalStatus.PENDING)
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
          type: WalletTxType.RELEASE,
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
          status: WithdrawalStatus.REJECTED,
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
