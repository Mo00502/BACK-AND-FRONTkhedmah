import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { SchedulerService } from './scheduler.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { MaterialsPaymentModule } from '../materials-payment/materials-payment.module';

@Module({
  imports: [ConfigModule, PrismaModule, MaterialsPaymentModule],
  providers: [SchedulerService],
})
export class SchedulerModule {}
