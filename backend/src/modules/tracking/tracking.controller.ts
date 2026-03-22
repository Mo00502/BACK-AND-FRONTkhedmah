import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { TrackingService } from './tracking.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ThrottleRelaxed } from '../../common/decorators/throttle.decorator';

@ApiTags('tracking')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('tracking')
export class TrackingController {
  constructor(private tracking: TrackingService) {}

  @ThrottleRelaxed()
  @Get('requests/:requestId')
  @ApiOperation({ summary: 'Get full order tracking info (steps + provider + WebSocket room)' })
  getTracking(@CurrentUser('id') userId: string, @Param('requestId') requestId: string) {
    return this.tracking.getOrderTracking(userId, requestId);
  }

  @ThrottleRelaxed()
  @Get('active')
  @ApiOperation({ summary: 'List my active orders (ACCEPTED or IN_PROGRESS)' })
  getActive(@CurrentUser('id') userId: string, @CurrentUser('role') role: string) {
    return this.tracking.getActiveOrders(userId, role as any);
  }
}
