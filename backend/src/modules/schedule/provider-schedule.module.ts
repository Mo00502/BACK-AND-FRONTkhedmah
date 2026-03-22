import { Module } from '@nestjs/common';
import { ProviderScheduleService } from './provider-schedule.service';
import { ProviderScheduleController } from './provider-schedule.controller';

@Module({
  controllers: [ProviderScheduleController],
  providers: [ProviderScheduleService],
  exports: [ProviderScheduleService],
})
export class ProviderScheduleModule {}
