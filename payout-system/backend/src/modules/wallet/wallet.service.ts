import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { WalletTxType } from '@prisma/client';
import * as crypto from 'crypto';

@Injectable()
export class WalletService {
  private readonly logger = new Logger(WalletService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Get existing wallet or create one atomically.
   */
  async getOrCreate(userId: string) {
    let wallet = await this.prisma.wallet.findUnique({ where: { userId } });

    if (!wallet) {
      wallet = await this.prisma.wallet.create({
        data: { userId, availableBalance: 0, pendingBalance: 0, escrowBalance: 0 },
      });
    }

    return wallet;
  }

  /**
   * Get current balances for a user's wallet.
   */
  async getBalance(userId: string): Promise<{
    available: number;
    pending: number;
    escrow: number;
  }> {
    const wallet = await this.getOrCreate(userId);
    return {
      available: Number(wallet.availableBalance),
      pending: Number(wallet.pendingBalance),
      escrow: Number(wallet.escrowBalance),
    };
  }

  /**
   * Credit available balance.
   * Idempotency key prevents double-credit on retry.
   */
  async credit(
    userId: string,
    amount: number,
    description: string,
    idempotencyKey?: string,
  ): Promise<void> {
    if (amount <= 0) throw new BadRequestException('Credit amount must be positive');

    const idemKey = idempotencyKey ?? crypto.randomUUID();

    // Check idempotency
    if (idempotencyKey) {
      const existing = await this.prisma.walletTransaction.findUnique({
        where: { idempotencyKey: idemKey },
      });
      if (existing) {
        this.logger.warn(`Duplicate credit skipped: key=${idemKey}`);
        return;
      }
    }

    await this.prisma.$transaction(async (tx) => {
      const wallet = await tx.wallet.findUnique({ where: { userId } });
      if (!wallet) throw new NotFoundException(`Wallet not found for user ${userId}`);

      const newBalance = Number(wallet.availableBalance) + amount;

      await tx.wallet.update({
        where: { id: wallet.id },
        data: { availableBalance: newBalance },
      });

      await tx.walletTransaction.create({
        data: {
          walletId: wallet.id,
          type: WalletTxType.CREDIT,
          amount,
          balanceAfter: newBalance,
          description,
          idempotencyKey: idemKey,
        },
      });
    });

    this.logger.log(`Wallet credited: userId=${userId} amount=${amount}`);
  }

  /**
   * Debit available balance.
   * Throws if insufficient funds — uses conditional updateMany for atomicity.
   */
  async debit(userId: string, amount: number, description: string): Promise<void> {
    if (amount <= 0) throw new BadRequestException('Debit amount must be positive');

    await this.prisma.$transaction(async (tx) => {
      const wallet = await tx.wallet.findUnique({ where: { userId } });
      if (!wallet) throw new NotFoundException(`Wallet not found for user ${userId}`);

      const current = Number(wallet.availableBalance);
      if (current < amount) {
        throw new BadRequestException(
          `Insufficient balance. Available: ${current}, Required: ${amount}`,
        );
      }

      const newBalance = current - amount;

      // Conditional update prevents race condition
      const updated = await tx.wallet.updateMany({
        where: {
          id: wallet.id,
          availableBalance: { gte: amount },
        },
        data: { availableBalance: newBalance },
      });

      if (updated.count === 0) {
        throw new BadRequestException('Insufficient balance (concurrent modification detected)');
      }

      await tx.walletTransaction.create({
        data: {
          walletId: wallet.id,
          type: WalletTxType.DEBIT,
          amount,
          balanceAfter: newBalance,
          description,
        },
      });
    });

    this.logger.log(`Wallet debited: userId=${userId} amount=${amount}`);
  }

  /**
   * Move funds from available to escrow.
   */
  async holdEscrow(userId: string, amount: number): Promise<void> {
    if (amount <= 0) throw new BadRequestException('Amount must be positive');

    await this.prisma.$transaction(async (tx) => {
      const wallet = await tx.wallet.findUnique({ where: { userId } });
      if (!wallet) throw new NotFoundException(`Wallet not found for user ${userId}`);

      const available = Number(wallet.availableBalance);
      if (available < amount) {
        throw new BadRequestException('Insufficient available balance for escrow hold');
      }

      const updated = await tx.wallet.updateMany({
        where: {
          id: wallet.id,
          availableBalance: { gte: amount },
        },
        data: {
          availableBalance: { decrement: amount },
          escrowBalance: { increment: amount },
        },
      });

      if (updated.count === 0) {
        throw new BadRequestException('Escrow hold failed (concurrent modification)');
      }

      const newAvailable = available - amount;

      await tx.walletTransaction.create({
        data: {
          walletId: wallet.id,
          type: WalletTxType.DEBIT,
          amount,
          balanceAfter: newAvailable,
          description: 'Escrow hold',
        },
      });
    });
  }

  /**
   * Move funds from escrow to pending (after escrow released, pending payout).
   */
  async releaseFromEscrow(userId: string, amount: number): Promise<void> {
    if (amount <= 0) throw new BadRequestException('Amount must be positive');

    await this.prisma.$transaction(async (tx) => {
      const wallet = await tx.wallet.findUnique({ where: { userId } });
      if (!wallet) throw new NotFoundException(`Wallet not found for user ${userId}`);

      const escrow = Number(wallet.escrowBalance);
      if (escrow < amount) {
        throw new BadRequestException('Insufficient escrow balance for release');
      }

      const updated = await tx.wallet.updateMany({
        where: {
          id: wallet.id,
          escrowBalance: { gte: amount },
        },
        data: {
          escrowBalance: { decrement: amount },
          pendingBalance: { increment: amount },
        },
      });

      if (updated.count === 0) {
        throw new BadRequestException('Escrow release failed (concurrent modification)');
      }

      await tx.walletTransaction.create({
        data: {
          walletId: wallet.id,
          type: WalletTxType.CREDIT,
          amount,
          balanceAfter: Number(wallet.availableBalance),
          description: 'Escrow released to pending',
        },
      });
    });
  }

  /**
   * Move funds from pending to available balance.
   */
  async movePendingToAvailable(userId: string, amount: number): Promise<void> {
    if (amount <= 0) throw new BadRequestException('Amount must be positive');

    await this.prisma.$transaction(async (tx) => {
      const wallet = await tx.wallet.findUnique({ where: { userId } });
      if (!wallet) throw new NotFoundException(`Wallet not found for user ${userId}`);

      const pending = Number(wallet.pendingBalance);
      if (pending < amount) {
        throw new BadRequestException('Insufficient pending balance');
      }

      const updated = await tx.wallet.updateMany({
        where: {
          id: wallet.id,
          pendingBalance: { gte: amount },
        },
        data: {
          pendingBalance: { decrement: amount },
          availableBalance: { increment: amount },
        },
      });

      if (updated.count === 0) {
        throw new BadRequestException('Move failed (concurrent modification)');
      }

      const newAvailable = Number(wallet.availableBalance) + amount;

      await tx.walletTransaction.create({
        data: {
          walletId: wallet.id,
          type: WalletTxType.CREDIT,
          amount,
          balanceAfter: newAvailable,
          description: 'Pending balance moved to available',
        },
      });
    });
  }

  /**
   * Get transaction history for a wallet.
   */
  async getTransactionHistory(userId: string, page = 1, limit = 20) {
    const wallet = await this.prisma.wallet.findUnique({ where: { userId } });
    if (!wallet) return { transactions: [], total: 0 };

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
}
