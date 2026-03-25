import { Module } from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { PaymentsController } from './payments.controller';
import { MoyasarService } from './moyasar.service';
import { EscrowModule } from '../escrow/escrow.module';
import { LedgerModule } from '../ledger/ledger.module';

@Module({
  imports: [EscrowModule, LedgerModule],
  providers: [PaymentsService, MoyasarService],
  controllers: [PaymentsController],
  exports: [PaymentsService, MoyasarService],
})
export class PaymentsModule {}
