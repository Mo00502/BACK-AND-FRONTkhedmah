import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import {
  IsString,
  IsNumber,
  IsPositive,
  IsOptional,
  IsBoolean,
  IsDateString,
  IsInt,
  Min,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { MaterialsPaymentService } from './materials-payment.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UserRole, MaterialsPaymentStatus } from '@prisma/client';
import {
  ThrottleStrict,
  ThrottleDefault,
  ThrottleRelaxed,
} from '../../common/decorators/throttle.decorator';

class LogUsageDto {
  @ApiProperty() @IsNumber() @IsPositive() amount: number;
  @ApiProperty() @IsString() description: string;
  @ApiProperty() @IsDateString() purchasedAt: string;
}

class UploadReceiptDto {
  @ApiProperty() @IsString() fileUrl: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() fileType?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() notes?: string;
}

class RequestAdjustmentDto {
  @ApiProperty() @IsNumber() @IsPositive() additionalAmount: number;
  @ApiProperty() @IsString() reason: string;
  @ApiProperty({ required: false }) @IsOptional() itemBreakdown?: any;
}

class RespondAdjustmentDto {
  @ApiProperty() @IsBoolean() approve: boolean;
}

class AdminReviewDto {
  @ApiProperty() @IsBoolean() approve: boolean;
  @ApiProperty({ required: false }) @IsOptional() @IsString() notes?: string;
}

@ApiTags('materials-payment')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('materials')
export class MaterialsPaymentController {
  constructor(private mp: MaterialsPaymentService) {}

  // ── Admin: list all materials payments ───────────────────────────────────
  // IMPORTANT: This must be declared BEFORE @Get(':requestId') so NestJS does not
  // match the literal path segment 'admin' as the :requestId wildcard parameter.
  @Get('admin/list')
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @ThrottleRelaxed()
  @ApiOperation({ summary: 'Admin: list all materials payment records' })
  adminList(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: MaterialsPaymentStatus,
  ) {
    return this.mp.adminList(
      page ? parseInt(page, 10) : 1,
      limit ? parseInt(limit, 10) : 20,
      status,
    );
  }

  // ── Customer / Provider: view materials summary ───────────────────────────
  @Get(':requestId')
  @ThrottleRelaxed()
  @ApiOperation({ summary: 'Get full materials payment summary for an order' })
  getSummary(@Param('requestId') requestId: string, @CurrentUser('id') userId: string) {
    return this.mp.getSummary(requestId, userId);
  }

  // ── Provider: log a materials purchase ───────────────────────────────────
  @Post(':requestId/usage')
  @Roles(UserRole.PROVIDER)
  @ThrottleDefault()
  @ApiOperation({ summary: 'Provider: log a materials purchase against the order budget' })
  logUsage(
    @Param('requestId') requestId: string,
    @CurrentUser('id') providerId: string,
    @Body() dto: LogUsageDto,
  ) {
    return this.mp.logUsage(
      providerId,
      requestId,
      dto.amount,
      dto.description,
      new Date(dto.purchasedAt),
    );
  }

  // ── Provider: upload receipt for a usage log ─────────────────────────────
  @Post('usage/:usageLogId/receipts')
  @Roles(UserRole.PROVIDER)
  @ThrottleDefault()
  @ApiOperation({ summary: 'Provider: upload receipt/proof for a logged materials purchase' })
  uploadReceipt(
    @Param('usageLogId') usageLogId: string,
    @CurrentUser('id') providerId: string,
    @Body() dto: UploadReceiptDto,
  ) {
    return this.mp.uploadReceipt(
      providerId,
      usageLogId,
      dto.fileUrl,
      dto.fileType ?? 'RECEIPT',
      dto.notes,
    );
  }

  // ── Provider: request more budget ────────────────────────────────────────
  @Post(':requestId/adjustment')
  @Roles(UserRole.PROVIDER)
  @ThrottleStrict()
  @ApiOperation({ summary: 'Provider: request additional materials budget from customer' })
  requestAdjustment(
    @Param('requestId') requestId: string,
    @CurrentUser('id') providerId: string,
    @Body() dto: RequestAdjustmentDto,
  ) {
    return this.mp.requestAdjustment(
      providerId,
      requestId,
      dto.additionalAmount,
      dto.reason,
      dto.itemBreakdown,
    );
  }

  // ── Customer: approve or reject an adjustment request ────────────────────
  @Patch('adjustments/:adjustmentId/respond')
  @Roles(UserRole.CUSTOMER)
  @HttpCode(HttpStatus.OK)
  @ThrottleStrict()
  @ApiOperation({ summary: 'Customer: approve or reject a materials budget adjustment request' })
  respondToAdjustment(
    @Param('adjustmentId') adjustmentId: string,
    @CurrentUser('id') customerId: string,
    @Body() dto: RespondAdjustmentDto,
  ) {
    return this.mp.respondToAdjustment(customerId, adjustmentId, dto.approve);
  }

  // ── Admin: review a usage log entry ──────────────────────────────────────
  @Patch('admin/usage/:usageLogId/review')
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @HttpCode(HttpStatus.OK)
  @ThrottleDefault()
  @ApiOperation({ summary: 'Admin: approve or reject a materials usage log entry' })
  reviewUsage(
    @Param('usageLogId') usageLogId: string,
    @CurrentUser('id') adminId: string,
    @Body() dto: AdminReviewDto,
  ) {
    return this.mp.reviewUsageLog(adminId, usageLogId, dto.approve, dto.notes);
  }

  // ── Admin: reconcile (finalize & refund unused) ───────────────────────────
  @Post('admin/:requestId/reconcile')
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @HttpCode(HttpStatus.OK)
  @ThrottleStrict()
  @ApiOperation({ summary: 'Admin: finalize materials budget — compute used, refund unused' })
  reconcile(@Param('requestId') requestId: string, @CurrentUser('id') adminId: string) {
    return this.mp.reconcile(requestId, adminId);
  }
}
