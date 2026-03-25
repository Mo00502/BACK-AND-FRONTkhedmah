import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { WalletService } from './wallet.service';
import { WalletController } from './wallet.controller';
import { WalletCreditProducer, WALLET_CREDIT_QUEUE } from './wallet-credit.queue';
import { WalletCreditProcessor } from './wallet-credit.processor';
import { PrismaModule } from '../../prisma/prisma.module';

@Module({
  imports: [
    PrismaModule,
    BullModule.registerQueue({ name: WALLET_CREDIT_QUEUE }),
  ],
  controllers: [WalletController],
  providers: [WalletService, WalletCreditProducer, WalletCreditProcessor],
  exports: [WalletService, WalletCreditProducer],
})
export class WalletModule {}
