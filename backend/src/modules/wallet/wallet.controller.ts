import { Controller, Get, Post, Patch, Body, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiProperty } from '@nestjs/swagger';
import { IsString, IsNumber, Min, IsOptional, IsIBAN } from 'class-validator';
import { WalletService } from './wallet.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import {
  ThrottleDefault,
  ThrottleRelaxed,
  ThrottleStrict,
} from '../../common/decorators/throttle.decorator';
import { UserRole } from '@prisma/client';

class RequestWithdrawalDto {
  @ApiProperty({ example: 500, description: 'Amount in SAR (min 50)' })
  @IsNumber()
  @Min(50)
  amount: number;

  @ApiProperty({ example: 'SA0380000000608010167519' })
  @IsIBAN()
  iban: string;

  @ApiProperty({ example: 'البنك الأهلي' })
  @IsString()
  bankName: string;

  @ApiProperty({ example: 'محمد أحمد الغامدي' })
  @IsString()
  beneficiaryName: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  notes?: string;
}

class ProcessWithdrawalDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  adminNote?: string;
}

@ApiTags('wallet')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('wallet')
export class WalletController {
  constructor(private wallet: WalletService) {}

  @Get('balance')
  @Roles(UserRole.CUSTOMER, UserRole.PROVIDER)
  @ThrottleDefault()
  @ApiOperation({ summary: 'Get current wallet balance (available + held)' })
  getBalance(@CurrentUser() user: any) {
    return this.wallet.getBalance(user.id);
  }

  @Get('transactions')
  @Roles(UserRole.CUSTOMER, UserRole.PROVIDER)
  @ThrottleDefault()
  @ApiOperation({ summary: 'Get wallet transaction history' })
  getTransactions(@CurrentUser() user: any, @Query('page') page = 1, @Query('limit') limit = 20) {
    return this.wallet.getTransactions(user.id, +page, +limit);
  }

  @Post('withdraw')
  @Roles(UserRole.PROVIDER)
  @ThrottleStrict()
  @ApiOperation({ summary: 'Request a bank withdrawal (holds balance until processed)' })
  requestWithdrawal(@CurrentUser('id') userId: string, @Body() dto: RequestWithdrawalDto) {
    return this.wallet.requestWithdrawal(
      userId,
      dto.amount,
      dto.iban,
      dto.bankName,
      dto.beneficiaryName,
      dto.notes,
    );
  }

  @Get('withdrawals')
  @Roles(UserRole.PROVIDER)
  @ThrottleDefault()
  @ApiOperation({ summary: 'List my withdrawal requests' })
  getWithdrawals(
    @CurrentUser('id') userId: string,
    @Query('page') page = 1,
    @Query('limit') limit = 10,
  ) {
    return this.wallet.getWithdrawals(userId, +page, +limit);
  }

  @Get('referral/my-code')
  @Roles(UserRole.CUSTOMER, UserRole.PROVIDER)
  @ThrottleRelaxed()
  @ApiOperation({ summary: 'Get my referral code and stats (total referrals + earned amount)' })
  getMyReferralCode(@CurrentUser('id') userId: string) {
    return this.wallet.getMyReferralCode(userId);
  }

  // ── Admin endpoints ────────────────────────────────────────────────────────

  @Get('admin/withdrawals')
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @ThrottleRelaxed()
  @ApiOperation({
    summary: 'Admin: list withdrawal requests (default: PENDING, use status=ALL for all)',
  })
  adminListWithdrawals(
    @Query('status') status = 'PENDING',
    @Query('page') page = 1,
    @Query('limit') limit = 20,
  ) {
    return this.wallet.adminListWithdrawals(status, +page, +limit);
  }

  @Patch('admin/withdrawals/:id/approve')
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @ThrottleStrict()
  @ApiOperation({ summary: 'Admin: approve and complete a withdrawal' })
  approveWithdrawal(
    @Param('id') id: string,
    @CurrentUser('id') adminId: string,
    @Body() dto: ProcessWithdrawalDto,
  ) {
    return this.wallet.approveWithdrawal(id, adminId, dto.adminNote);
  }

  @Patch('admin/withdrawals/:id/reject')
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @ThrottleStrict()
  @ApiOperation({ summary: 'Admin: reject a withdrawal and release the hold' })
  rejectWithdrawal(
    @Param('id') id: string,
    @CurrentUser('id') adminId: string,
    @Body() dto: ProcessWithdrawalDto,
  ) {
    return this.wallet.rejectWithdrawal(id, adminId, dto.adminNote ?? 'No reason provided');
  }
}
