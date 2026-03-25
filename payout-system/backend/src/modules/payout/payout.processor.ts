import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { WalletService } from '../wallet/wallet.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { BankAccountService } from './bank-account.service';
import { PAYOUT_QUEUE, PayoutJobData } from './payout-queue';
import { PayoutStatus, LedgerType } from '@prisma/client';

const MAX_ATTEMPTS = 5;

@Processor(PAYOUT_QUEUE)
export class PayoutProcessor extends WorkerHost {
  private readonly logger = new Logger(PayoutProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly walletService: WalletService,
    private readonly eventEmitter: EventEmitter2,
    private readonly bankAccountService: BankAccountService,
  ) {
    super();
  }

  async process(job: Job<PayoutJobData>): Promise<void> {
    const { payoutId, attempt } = job.data;
    this.logger.log(`Processing payout: id=${payoutId} attempt=${attempt}`);

    const payout = await this.prisma.payout.findUnique({
      where: { id: payoutId },
      include: {
        provider: {
          include: { user: true, bankAccounts: true },
        },
        bankAccount: true,
        escrow: true,
      },
    });

    if (!payout) {
      this.logger.error(`Payout ${payoutId} not found`);
      throw new Error(`Payout ${payoutId} not found`);
    }

    // Skip already completed/cancelled payouts
    if (payout.status === PayoutStatus.COMPLETED || payout.status === PayoutStatus.CANCELLED) {
      this.logger.warn(`Payout ${payoutId} is already ${payout.status} — skipping`);
      return;
    }

    // Validate KYC
    if (payout.provider.kycStatus !== 'APPROVED') {
      const reason = `Provider KYC not approved (status: ${payout.provider.kycStatus})`;
      await this.markFailed(payoutId, reason, attempt);
      throw new Error(reason);
    }

    // Validate bank account
    if (!payout.bankAccount) {
      const reason = 'No bank account found for payout';
      await this.markFailed(payoutId, reason, attempt);
      throw new Error(reason);
    }

    // Validate amount
    const amount = Number(payout.amount);
    if (amount <= 0) {
      const reason = `Invalid payout amount: ${amount}`;
      await this.markFailed(payoutId, reason, attempt);
      throw new Error(reason);
    }

    // Decrypt IBAN
    let iban: string;
    try {
      const result = await this.bankAccountService.getWithDecryptedIban(
        payout.bankAccountId,
        payout.providerId,
      );
      iban = result.iban;
    } catch (error) {
      const reason = `IBAN decryption failed: ${error.message}`;
      await this.markFailed(payoutId, reason, attempt);
      throw new Error(reason);
    }

    // Mark as processing
    await this.prisma.payout.update({
      where: { id: payoutId },
      data: { status: PayoutStatus.PROCESSING, attemptCount: attempt },
    });

    // Attempt bank transfer
    try {
      const gatewayRef = await this.executeBankTransfer({
        iban,
        beneficiaryName: payout.bankAccount.fullName,
        bankName: payout.bankAccount.bankName,
        amount,
        reference: payout.idempotencyKey,
        providerId: payout.providerId,
      });

      // Success
      await this.prisma.payout.update({
        where: { id: payoutId },
        data: {
          status: PayoutStatus.COMPLETED,
          gatewayRef,
          processedAt: new Date(),
          attemptCount: attempt,
        },
      });

      await this.ledger.record(
        LedgerType.PAYOUT_COMPLETED,
        payoutId,
        amount,
        payout.escrow?.orderId,
        `Payout completed to ${payout.bankAccount.bankName} ****${payout.bankAccount.ibanLast4}`,
        { gatewayRef, attempt },
      );

      // Move wallet from pending → available
      await this.walletService.movePendingToAvailable(payout.provider.userId, amount);

      this.eventEmitter.emit('payout.completed', {
        payoutId,
        providerId: payout.providerId,
        providerUserId: payout.provider.userId,
        amount,
        gatewayRef,
      });

      this.logger.log(`Payout COMPLETED: id=${payoutId} amount=${amount} ref=${gatewayRef}`);
    } catch (error) {
      this.logger.error(`Payout attempt ${attempt} failed: ${error.message}`);

      const isLastAttempt = attempt >= MAX_ATTEMPTS;
      const failureReason = error.message;

      if (isLastAttempt) {
        await this.markFailed(payoutId, failureReason, attempt);

        this.eventEmitter.emit('payout.failed', {
          payoutId,
          providerId: payout.providerId,
          providerUserId: payout.provider.userId,
          amount,
          reason: failureReason,
        });
      } else {
        await this.prisma.payout.update({
          where: { id: payoutId },
          data: {
            status: PayoutStatus.QUEUED,
            attemptCount: attempt,
            failureReason,
          },
        });
      }

      throw error; // BullMQ will retry with exponential backoff
    }
  }

  private async markFailed(payoutId: string, reason: string, attempt: number): Promise<void> {
    await this.prisma.payout.update({
      where: { id: payoutId },
      data: {
        status: PayoutStatus.FAILED,
        failureReason: reason,
        attemptCount: attempt,
      },
    });

    await this.ledger.record(
      LedgerType.PAYOUT_FAILED,
      payoutId,
      0,
      undefined,
      `Payout failed: ${reason}`,
      { attempt },
    );
  }

  /**
   * Execute the actual bank transfer.
   * In production, this integrates with SADAD/SARIE/Moyasar Payouts API.
   * Currently simulates success for development.
   */
  private async executeBankTransfer(params: {
    iban: string;
    beneficiaryName: string;
    bankName: string;
    amount: number;
    reference: string;
    providerId: string;
  }): Promise<string> {
    this.logger.log(
      `[MOCK] Bank transfer: IBAN=****${params.iban.slice(-4)} ` +
        `amount=${params.amount} SAR ` +
        `beneficiary="${params.beneficiaryName}" ` +
        `bank="${params.bankName}" ` +
        `ref=${params.reference}`,
    );

    // Simulate network delay
    await new Promise((resolve) => setTimeout(resolve, 500));

    // In production: call SARIE/SADAD/Moyasar Payouts API here
    // Return real gateway reference from the bank transfer API response
    const mockGatewayRef = `BANK-${Date.now()}-${params.reference.slice(0, 8).toUpperCase()}`;

    this.logger.log(`[MOCK] Bank transfer successful: ref=${mockGatewayRef}`);
    return mockGatewayRef;
  }
}
