import { Module } from '@nestjs/common';
import { ReleaseService } from './release.service';
import { EscrowModule } from '../escrow/escrow.module';

@Module({
  imports: [EscrowModule],
  providers: [ReleaseService],
  exports: [ReleaseService],
})
export class ReleaseModule {}
