import { Module } from '@nestjs/common';
import { SchedulerService } from './scheduler.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { MaterialsPaymentModule } from '../materials-payment/materials-payment.module';

@Module({
  imports: [PrismaModule, MaterialsPaymentModule],
  providers: [SchedulerService],
})
export class SchedulerModule {}
