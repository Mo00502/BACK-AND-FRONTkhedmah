import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { WalletService } from '../wallet/wallet.service';
import { PAYOUT_QUEUE, PayoutJobData } from './payout-queue';
import { PayoutStatus, LedgerType } from '@prisma/client';
import * as crypto from 'crypto';

@Injectable()
export class PayoutService {
  private readonly logger = new Logger(PayoutService.name);

  constructor(
    @InjectQueue(PAYOUT_QUEUE) private readonly payoutQueue: Queue,
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly walletService: WalletService,
  ) {}

  /**
   * Request a payout for a released escrow.
   * Validates KYC + default bank account, then enqueues the job.
   */
  async requestPayout(providerUserId: string, escrowId: string) {
    // Get provider profile
    const provider = await this.prisma.provider.findUnique({
      where: { userId: providerUserId },
      include: { bankAccounts: { where: { isDefault: true } } },
    });

    if (!provider) {
      throw new NotFoundException('Provider profile not found');
    }

    if (provider.kycStatus !== 'APPROVED') {
      throw new BadRequestException(
        `Provider KYC must be APPROVED before requesting payout (current: ${provider.kycStatus})`,
      );
    }

    const defaultBankAccount = provider.bankAccounts[0];
    if (!defaultBankAccount) {
      throw new BadRequestException(
        'No default bank account configured. Please add a bank account first.',
      );
    }

    // Validate escrow
    const escrow = await this.prisma.escrow.findUnique({
      where: { id: escrowId },
      include: { order: true },
    });

    if (!escrow) {
      throw new NotFoundException(`Escrow ${escrowId} not found`);
    }

    if (escrow.status !== 'RELEASED') {
      throw new BadRequestException(
        `Escrow must be RELEASED before payout (current: ${escrow.status})`,
      );
    }

    // Verify the escrow belongs to this provider
    if (escrow.order.providerId !== provider.id) {
      throw new BadRequestException('This escrow does not belong to your orders');
    }

    // Idempotency: check if payout for this escrow already exists
    const existingPayout = await this.prisma.payout.findUnique({
      where: { escrowId },
    });

    if (existingPayout) {
      if (existingPayout.status === PayoutStatus.COMPLETED) {
        throw new ConflictException('Payout for this escrow is already completed');
      }
      if (
        existingPayout.status === PayoutStatus.QUEUED ||
        existingPayout.status === PayoutStatus.PROCESSING
      ) {
        return { message: 'Payout is already in progress', payout: existingPayout };
      }
    }

    const idempotencyKey = crypto.randomUUID();
    const amount = Number(escrow.providerAmount);

    // Create payout record + move wallet escrow → pending atomically
    const payout = await this.prisma.$transaction(async (tx) => {
      const newPayout = await tx.payout.create({
        data: {
          providerId: provider.id,
          bankAccountId: defaultBankAccount.id,
          escrowId,
          amount,
          idempotencyKey,
          status: PayoutStatus.QUEUED,
        },
      });

      return newPayout;
    });

    // Release escrow balance to pending in wallet
    await this.walletService.releaseFromEscrow(providerUserId, amount);

    // Record in ledger
    await this.ledger.record(
      LedgerType.PAYOUT_INITIATED,
      payout.id,
      amount,
      escrow.orderId,
      `Payout initiated for order ${escrow.orderId}`,
      { payoutId: payout.id, escrowId },
    );

    // Enqueue BullMQ job
    const jobData: PayoutJobData = { payoutId: payout.id, attempt: 1 };
    await this.payoutQueue.add('process-payout', jobData, {
      attempts: 5,
      backoff: { type: 'exponential', delay: 2000 },
      jobId: `payout-${payout.id}`, // Idempotent job ID
    });

    this.logger.log(`Payout queued: id=${payout.id} amount=${amount} provider=${provider.id}`);

    return { message: 'Payout request submitted', payout };
  }

  /**
   * List payouts for a provider with pagination.
   */
  async listPayouts(providerUserId: string, page = 1, limit = 20) {
    const provider = await this.prisma.provider.findUnique({
      where: { userId: providerUserId },
    });

    if (!provider) throw new NotFoundException('Provider profile not found');

    const skip = (page - 1) * limit;

    const [payouts, total] = await Promise.all([
      this.prisma.payout.findMany({
        where: { providerId: provider.id },
        include: {
          bankAccount: {
            select: { bankName: true, ibanLast4: true, isDefault: true },
          },
          escrow: {
            select: { orderId: true, status: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.payout.count({ where: { providerId: provider.id } }),
    ]);

    return { payouts, total, page, limit };
  }

  /**
   * Admin: list all payouts with optional status filter.
   */
  async adminListPayouts(
    filters: { status?: PayoutStatus; providerId?: string },
    page = 1,
    limit = 50,
  ) {
    const where: any = {};
    if (filters.status) where.status = filters.status;
    if (filters.providerId) where.providerId = filters.providerId;

    const skip = (page - 1) * limit;

    const [payouts, total] = await Promise.all([
      this.prisma.payout.findMany({
        where,
        include: {
          provider: {
            include: {
              user: { select: { firstName: true, lastName: true, email: true } },
            },
          },
          bankAccount: {
            select: { bankName: true, ibanLast4: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.payout.count({ where }),
    ]);

    return { payouts, total, page, limit };
  }

  /**
   * Admin: retry a failed payout.
   */
  async retryFailed(payoutId: string): Promise<void> {
    const payout = await this.prisma.payout.findUnique({ where: { id: payoutId } });

    if (!payout) throw new NotFoundException(`Payout ${payoutId} not found`);

    if (payout.status !== PayoutStatus.FAILED) {
      throw new BadRequestException(`Only FAILED payouts can be retried (current: ${payout.status})`);
    }

    await this.prisma.payout.update({
      where: { id: payoutId },
      data: { status: PayoutStatus.QUEUED, failureReason: null },
    });

    const attempt = payout.attemptCount + 1;
    const jobData: PayoutJobData = { payoutId, attempt };

    await this.payoutQueue.add('process-payout', jobData, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
    });

    this.logger.log(`Payout retry enqueued: id=${payoutId} attempt=${attempt}`);
  }
}
