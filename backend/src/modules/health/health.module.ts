import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { BullModule } from '@nestjs/bull';
import { HealthController } from './health.controller';

@Module({
  imports: [TerminusModule, BullModule.registerQueue({ name: 'notifications' })],
  controllers: [HealthController],
})
export class HealthModule {}
