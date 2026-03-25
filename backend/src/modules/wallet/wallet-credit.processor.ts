import { Process, Processor, OnQueueFailed } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';
import * as Sentry from '@sentry/node';
import { WalletCreditJobData, WALLET_CREDIT_QUEUE } from './wallet-credit.queue';
import { WalletService } from './wallet.service';
import { PrismaService } from '../../prisma/prisma.service';

@Processor(WALLET_CREDIT_QUEUE)
export class WalletCreditProcessor {
  private readonly logger = new Logger(WalletCreditProcessor.name);

  constructor(
    private readonly wallet: WalletService,
    private readonly prisma: PrismaService,
  ) {}

  @Process('credit')
  async handleCredit(job: Job<WalletCreditJobData>): Promise<void> {
    const { userId, amount, referenceId, refType, description, idempotencyKey } = job.data;

    // Idempotency check: has this credit already been applied?
    const alreadyCredited = await this.prisma.walletTransaction.findFirst({
      where: { idempotencyKey },
    });
    if (alreadyCredited) {
      this.logger.log(`Skipping duplicate credit: ${idempotencyKey}`);
      return;
    }

    await this.wallet.credit(userId, amount, description, referenceId, refType, idempotencyKey);
    this.logger.log(
      `Wallet credit applied: ${idempotencyKey} — ${amount} SAR to user ${userId}`,
    );
  }

  // Called when all retry attempts are exhausted
  @OnQueueFailed()
  onFailed(job: Job<WalletCreditJobData>, error: Error): void {
    this.logger.error(
      `CRITICAL: Wallet credit permanently failed after ${job.attemptsMade} attempt(s). ` +
        `Job: ${job.data.idempotencyKey}, User: ${job.data.userId}, Amount: ${job.data.amount}. ` +
        `Error: ${error.message}`,
    );
    Sentry.captureException(error, {
      tags: { queue: WALLET_CREDIT_QUEUE, jobId: String(job.id) },
      extra: { jobData: job.data },
    });
  }
}
