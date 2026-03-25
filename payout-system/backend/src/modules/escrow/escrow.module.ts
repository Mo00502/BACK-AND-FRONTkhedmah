import { Module } from '@nestjs/common';
import { EscrowService } from './escrow.service';
import { LedgerModule } from '../ledger/ledger.module';

@Module({
  imports: [LedgerModule],
  providers: [EscrowService],
  exports: [EscrowService],
})
export class EscrowModule {}
