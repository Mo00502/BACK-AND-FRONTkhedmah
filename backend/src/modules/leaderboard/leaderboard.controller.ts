import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { LeaderboardService } from './leaderboard.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { ThrottleRelaxed } from '../../common/decorators/throttle.decorator';

@ApiTags('leaderboard')
@Controller('leaderboard')
export class LeaderboardController {
  constructor(private lb: LeaderboardService) {}

  @Public()
  @ThrottleRelaxed()
  @Get()
  @ApiOperation({ summary: 'Top providers leaderboard (public)' })
  @ApiQuery({ name: 'category', required: false, enum: ['OVERALL', 'WEEKLY', 'MONTHLY'] })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  getLeaderboard(@Query('category') category: any = 'OVERALL', @Query('limit') limit = 20) {
    return this.lb.getLeaderboard(category, +limit);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ThrottleRelaxed()
  @Get('my-badges')
  @ApiOperation({ summary: 'Get my earned badges' })
  getMyBadges(@CurrentUser('id') userId: string) {
    return this.lb.getMyBadges(userId);
  }

  @Public()
  @ThrottleRelaxed()
  @Get('providers/:providerId/stats')
  @ApiOperation({ summary: 'Provider stats card (public)' })
  getStats(@Param('providerId') providerId: string) {
    return this.lb.getProviderStats(providerId);
  }
}
