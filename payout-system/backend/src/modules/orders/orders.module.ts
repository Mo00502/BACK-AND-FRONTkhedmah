import { Module } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { CommissionModule } from '../commission/commission.module';
import { EscrowModule } from '../escrow/escrow.module';

@Module({
  imports: [CommissionModule, EscrowModule],
  providers: [OrdersService],
  controllers: [OrdersController],
  exports: [OrdersService],
})
export class OrdersModule {}
