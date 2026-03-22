import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { ReportsService } from './reports.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '@prisma/client';
import { ThrottleRelaxed } from '../../common/decorators/throttle.decorator';

@ApiTags('reports')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
@Controller('reports')
export class ReportsController {
  constructor(private reports: ReportsService) {}

  @Get('weekly')
  @ThrottleRelaxed()
  @ApiOperation({ summary: 'Admin: on-demand weekly platform report' })
  getWeeklyReport() {
    return this.reports.getWeeklyReportData();
  }

  @Get('overview')
  @ThrottleRelaxed()
  @ApiOperation({ summary: 'Admin: live platform overview (current totals + last 24h + last 7d)' })
  getOverview() {
    return this.reports.getOverviewData();
  }
}
