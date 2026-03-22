import { Controller, Get, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { CacheInterceptor, CacheKey, CacheTTL as CacheTTLDecorator } from '@nestjs/cache-manager';
import { AnalyticsService } from './analytics.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '@prisma/client';
import { CacheKeys, CacheTTL } from '../../common/utils/cache-keys';

@ApiTags('analytics')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
@Controller('analytics')
export class AnalyticsController {
  constructor(private analytics: AnalyticsService) {}

  @Get('overview')
  @ApiOperation({
    summary: 'Platform-wide GMV & revenue overview (all 3 verticals) — cached 5 min',
  })
  @UseInterceptors(CacheInterceptor)
  @CacheKey(CacheKeys.ANALYTICS_OVERVIEW)
  @CacheTTLDecorator(CacheTTL.MEDIUM)
  getOverview() {
    return this.analytics.getPlatformOverview();
  }

  @Get('trends')
  @ApiOperation({ summary: 'Monthly request, revenue & user growth trends' })
  @ApiQuery({ name: 'months', required: false, type: Number })
  getTrends(@Query('months') months = 12) {
    return this.analytics.getMonthlyTrends(+months);
  }

  @Get('top-providers')
  @ApiOperation({ summary: 'Top providers by completed jobs & rating' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  getTopProviders(@Query('limit') limit = 10) {
    return this.analytics.getTopProviders(+limit);
  }

  @Get('equipment')
  @ApiOperation({ summary: 'Equipment marketplace utilization stats' })
  getEquipmentStats() {
    return this.analytics.getEquipmentStats();
  }

  @Get('tenders')
  @ApiOperation({ summary: 'Tender ecosystem metrics & commission trends' })
  getTenderStats() {
    return this.analytics.getTenderStats();
  }

  @Get('funnel')
  @ApiOperation({ summary: 'Conversion funnel: created → quoted → paid → completed' })
  getFunnel() {
    return this.analytics.getConversionFunnel();
  }

  @Get('consultations')
  @ApiOperation({ summary: 'Consultation vertical: volume, mode split, rating avg, monthly trend' })
  getConsultationStats() {
    return this.analytics.getConsultationStats();
  }
}
