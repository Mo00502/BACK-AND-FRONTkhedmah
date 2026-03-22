import { Module } from '@nestjs/common';
import { MaterialsPaymentService } from './materials-payment.service';
import { MaterialsPaymentController } from './materials-payment.controller';

@Module({
  controllers: [MaterialsPaymentController],
  providers: [MaterialsPaymentService],
  exports: [MaterialsPaymentService],
})
export class MaterialsPaymentModule {}
