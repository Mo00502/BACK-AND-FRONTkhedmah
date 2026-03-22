import { Module } from '@nestjs/common';
import { EquipmentReviewsService } from './equipment-reviews.service';
import { EquipmentReviewsController } from './equipment-reviews.controller';
import { PrismaModule } from '../../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [EquipmentReviewsController],
  providers: [EquipmentReviewsService],
})
export class EquipmentReviewsModule {}
