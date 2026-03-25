import { InjectQueue } from '@nestjs/bull';
import { Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bull';

export const WALLET_CREDIT_QUEUE = 'wallet-credit';

export interface WalletCreditJobData {
  userId: string;
  amount: number;
  type: 'ESCROW_RELEASE' | 'RENTAL_COMPLETE' | 'CONSULTATION_EARNING' | 'REFUND' | 'DISPUTE_SPLIT';
  referenceId: string; // escrowId, rentalId, etc.
  refType?: string;    // forwarded to walletTransaction.refType
  description: string;
  idempotencyKey: string; // unique key to prevent double-credit
}

@Injectable()
export class WalletCreditProducer {
  private readonly logger = new Logger(WalletCreditProducer.name);

  constructor(
    @InjectQueue(WALLET_CREDIT_QUEUE) private readonly queue: Queue<WalletCreditJobData>,
  ) {}

  async enqueueCredit(data: WalletCreditJobData): Promise<void> {
    await this.queue.add('credit', data, {
      jobId: data.idempotencyKey,  // Bull deduplicates by jobId — prevents double-enqueue
      attempts: 5,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: { count: 1000 },
      removeOnFail: false, // keep failed jobs for inspection / dead-letter review
    });
    this.logger.log(`Enqueued wallet credit: ${data.idempotencyKey}`);
  }
}
