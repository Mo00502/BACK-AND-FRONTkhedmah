import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PayoutService } from './payout.service';
import { PayoutController } from './payout.controller';
import { PayoutProcessor } from './payout.processor';
import { BankAccountService } from './bank-account.service';
import { LedgerModule } from '../ledger/ledger.module';
import { WalletModule } from '../wallet/wallet.module';
import { PAYOUT_QUEUE } from './payout-queue';

@Module({
  imports: [
    BullModule.registerQueue({
      name: PAYOUT_QUEUE,
      defaultJobOptions: {
        attempts: 5,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
        removeOnComplete: 100,
        removeOnFail: 500,
      },
    }),
    LedgerModule,
    WalletModule,
  ],
  providers: [PayoutService, PayoutProcessor, BankAccountService],
  controllers: [PayoutController],
  exports: [PayoutService, BankAccountService],
})
export class PayoutModule {}
