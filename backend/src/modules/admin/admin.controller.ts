import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Query,
  Body,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { IsString, IsEnum } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { AdminService } from './admin.service';
import { ReportsService } from '../reports/reports.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UserRole } from '@prisma/client';
import {
  ThrottleStrict,
  ThrottleDefault,
  ThrottleRelaxed,
} from '../../common/decorators/throttle.decorator';

class SuspendDto {
  @ApiProperty() @IsString() reason: string;
}

class RejectProviderDto {
  @ApiProperty({ example: 'الوثائق المقدمة غير واضحة أو منتهية الصلاحية' })
  @IsString()
  reason: string;
}

class ResolveDisputeDto {
  @ApiProperty({ enum: ['REFUND', 'RELEASE', 'SPLIT', 'DISMISSED'] })
  @IsEnum(['REFUND', 'RELEASE', 'SPLIT', 'DISMISSED'])
  resolution: 'REFUND' | 'RELEASE' | 'SPLIT' | 'DISMISSED';

  @ApiProperty() @IsString() notes: string;
}

@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
@Controller('admin')
export class AdminController {
  constructor(
    private admin: AdminService,
    private reports: ReportsService,
  ) {}

  @Get('dashboard')
  @ThrottleRelaxed()
  @ApiOperation({ summary: 'Admin dashboard KPIs' })
  getDashboard() {
    return this.admin.getDashboardStats();
  }

  @Get('health')
  @ThrottleDefault()
  @ApiOperation({ summary: 'Real-time system health snapshot' })
  getHealth() {
    return this.admin.getSystemHealth();
  }

  @Get('stats/monthly')
  @ThrottleDefault()
  @ApiOperation({ summary: 'Last 6 months booking & revenue stats' })
  getMonthlyStats() {
    return this.admin.getMonthlyStats();
  }

  @Get('verifications/pending')
  @ThrottleRelaxed()
  @ApiOperation({ summary: 'Get providers pending verification' })
  getPendingVerifications(@Query('page') page = 1, @Query('limit') limit = 20) {
    return this.admin.getPendingVerifications(+page, +limit);
  }

  @Patch('verifications/:providerId/start-review')
  @ThrottleDefault()
  @ApiOperation({ summary: 'Mark provider as UNDER_REVIEW (admin opens the case)' })
  startReview(@Param('providerId') id: string) {
    return this.admin.startReview(id);
  }

  @Patch('verifications/:providerId/approve')
  @ThrottleStrict()
  @ApiOperation({ summary: 'Approve provider — sets APPROVED, notifies by email' })
  approve(@Param('providerId') id: string) {
    return this.admin.approveProvider(id);
  }

  @Patch('verifications/:providerId/reject')
  @ThrottleStrict()
  @ApiOperation({ summary: 'Reject provider verification with a reason' })
  reject(@Param('providerId') id: string, @Body() dto: RejectProviderDto) {
    return this.admin.rejectProvider(id, dto.reason);
  }

  @Patch('verifications/:providerId/suspend')
  @ThrottleStrict()
  @ApiOperation({ summary: 'Suspend an approved provider' })
  suspendProvider(@Param('providerId') id: string, @Body() dto: SuspendDto) {
    return this.admin.suspendProvider(id, dto.reason);
  }

  @Post('users/:userId/suspend')
  @ThrottleStrict()
  @ApiOperation({ summary: 'Suspend a user account' })
  suspendUser(
    @Param('userId') userId: string,
    @Body() dto: SuspendDto,
    @CurrentUser('id') adminId: string,
  ) {
    return this.admin.suspendUser(userId, dto.reason, adminId);
  }

  @Post('users/:userId/reinstate')
  @ThrottleStrict()
  @ApiOperation({ summary: 'Reinstate a suspended user' })
  reinstateUser(@Param('userId') userId: string) {
    return this.admin.reinstateUser(userId);
  }

  @Post('users/:userId/delete')
  @Roles(UserRole.SUPER_ADMIN)
  @ThrottleStrict()
  @ApiOperation({ summary: 'Soft-delete a user (SUPER_ADMIN only)' })
  deleteUser(@Param('userId') userId: string) {
    return this.admin.deleteUser(userId);
  }

  @Get('disputes')
  @ThrottleRelaxed()
  @ApiOperation({ summary: 'List open disputes' })
  getDisputes(@Query('page') page = 1, @Query('limit') limit = 20) {
    return this.admin.getDisputes(+page, +limit);
  }

  @Get('disputes/:disputeId')
  @ThrottleDefault()
  @ApiOperation({ summary: 'Get dispute detail by ID' })
  getDispute(@Param('disputeId') disputeId: string) {
    return this.admin.getDisputeById(disputeId);
  }

  @Post('disputes/:disputeId/resolve')
  @ThrottleStrict()
  @ApiOperation({ summary: 'Resolve a dispute (REFUND | RELEASE | SPLIT | DISMISSED)' })
  resolveDispute(
    @Param('disputeId') disputeId: string,
    @CurrentUser('id') adminId: string,
    @Body() dto: ResolveDisputeDto,
  ) {
    return this.admin.resolveDispute(disputeId, adminId, dto.resolution, dto.notes);
  }

  @Get('commissions/overdue')
  @ThrottleRelaxed()
  @ApiOperation({ summary: 'List tender commissions overdue >30 days' })
  getOverdueCommissions() {
    return this.admin.getOverdueCommissions();
  }

  @Get('reports/weekly')
  @ThrottleDefault()
  @ApiOperation({ summary: 'Generate weekly platform report on-demand' })
  getWeeklyReport() {
    return this.reports.getWeeklyReportData();
  }

  // ── Consultation management ───────────────────────────────────────────────

  @Get('consultations')
  @ThrottleRelaxed()
  @ApiOperation({ summary: 'Admin: list all consultations with optional status filter' })
  getConsultations(
    @Query('page') page = 1,
    @Query('limit') limit = 20,
    @Query('status') status?: string,
  ) {
    return this.admin.getConsultations(+page, +limit, status);
  }

  @Patch('consultations/:consultationId/cancel')
  @ThrottleStrict()
  @ApiOperation({ summary: 'Admin: force-cancel a consultation with a reason' })
  cancelConsultation(
    @Param('consultationId') consultationId: string,
    @CurrentUser('id') adminId: string,
    @Body() dto: SuspendDto,
  ) {
    return this.admin.cancelConsultationByAdmin(consultationId, adminId, dto.reason);
  }
}
