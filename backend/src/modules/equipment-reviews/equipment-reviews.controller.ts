import { Controller, Get, Post, Body, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { EquipmentReviewsService } from './equipment-reviews.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ThrottleStrict, ThrottleRelaxed } from '../../common/decorators/throttle.decorator';

@ApiTags('equipment-reviews')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('equipment-reviews')
export class EquipmentReviewsController {
  constructor(private reviews: EquipmentReviewsService) {}

  @ThrottleStrict()
  @Post('rentals/:rentalId')
  @ApiOperation({ summary: 'Submit review for a completed equipment rental' })
  submit(
    @Param('rentalId') rentalId: string,
    @CurrentUser() user: any,
    @Body() body: { score: number; comment?: string; photos?: string[] },
  ) {
    return this.reviews.submit(rentalId, user.id, body);
  }

  @ThrottleRelaxed()
  @Get('equipment/:equipmentId')
  @ApiOperation({ summary: 'Get reviews for a specific equipment' })
  list(@Param('equipmentId') id: string, @Query('page') page = 1, @Query('limit') limit = 20) {
    return this.reviews.listForEquipment(id, +page, +limit);
  }
}
