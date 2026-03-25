import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { PayoutService } from './payout.service';
import { BankAccountService } from './bank-account.service';
import { AddBankAccountDto, RequestPayoutDto } from './dto/payout.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import { UserRole, PayoutStatus } from '@prisma/client';

@ApiTags('payouts')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('payouts')
export class PayoutController {
  constructor(
    private readonly payoutService: PayoutService,
    private readonly bankAccountService: BankAccountService,
    private readonly prisma: PrismaService,
  ) {}

  @Post('bank-account')
  @Roles(UserRole.PROVIDER)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Add a bank account for payout (Provider only)' })
  @ApiResponse({ status: 201, description: 'Bank account added (IBAN encrypted and stored)' })
  @ApiResponse({ status: 400, description: 'Invalid IBAN format' })
  async addBankAccount(
    @CurrentUser('id') providerUserId: string,
    @Body() dto: AddBankAccountDto,
  ) {
    const provider = await this.resolveProvider(providerUserId);
    return this.bankAccountService.addBankAccount(provider.id, dto);
  }

  @Get('bank-accounts')
  @Roles(UserRole.PROVIDER)
  @ApiOperation({ summary: 'List my bank accounts (IBAN masked, showing last 4 digits)' })
  @ApiResponse({ status: 200, description: 'List of bank accounts' })
  async listBankAccounts(@CurrentUser('id') providerUserId: string) {
    const provider = await this.resolveProvider(providerUserId);
    return this.bankAccountService.list(provider.id);
  }

  @Post('bank-account/:id/set-default')
  @Roles(UserRole.PROVIDER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Set a bank account as the default for payouts' })
  @ApiResponse({ status: 200, description: 'Default bank account updated' })
  async setDefaultBankAccount(
    @Param('id') accountId: string,
    @CurrentUser('id') providerUserId: string,
  ) {
    const provider = await this.resolveProvider(providerUserId);
    await this.bankAccountService.setDefault(accountId, provider.id);
    return { message: 'Default bank account updated' };
  }

  @Post('request')
  @Roles(UserRole.PROVIDER)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Request a payout for a released escrow (Provider only)' })
  @ApiResponse({ status: 201, description: 'Payout request queued for processing' })
  @ApiResponse({ status: 400, description: 'Escrow not in RELEASED status or KYC not approved' })
  @ApiResponse({ status: 409, description: 'Payout already exists for this escrow' })
  async requestPayout(
    @CurrentUser('id') providerUserId: string,
    @Body() dto: RequestPayoutDto,
  ) {
    return this.payoutService.requestPayout(providerUserId, dto.escrowId);
  }

  @Get('history')
  @Roles(UserRole.PROVIDER)
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 20 })
  @ApiOperation({ summary: 'Get my payout history with status details (Provider only)' })
  @ApiResponse({ status: 200, description: 'Paginated payout history' })
  async getPayoutHistory(
    @CurrentUser('id') providerUserId: string,
    @Query('page') page = 1,
    @Query('limit') limit = 20,
  ) {
    return this.payoutService.listPayouts(providerUserId, Number(page), Number(limit));
  }

  @Get('admin/all')
  @Roles(UserRole.ADMIN)
  @ApiQuery({ name: 'status', required: false, enum: PayoutStatus })
  @ApiQuery({ name: 'providerId', required: false, type: String })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiOperation({ summary: 'Admin: list all payouts with optional status/provider filter' })
  @ApiResponse({ status: 200, description: 'Paginated list of all payouts with provider details' })
  async adminListPayouts(
    @Query('status') status?: PayoutStatus,
    @Query('providerId') providerId?: string,
    @Query('page') page = 1,
    @Query('limit') limit = 50,
  ) {
    return this.payoutService.adminListPayouts(
      { status, providerId },
      Number(page),
      Number(limit),
    );
  }

  @Post('admin/retry/:id')
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Admin: retry a failed payout' })
  @ApiResponse({ status: 200, description: 'Payout re-queued for retry' })
  @ApiResponse({ status: 400, description: 'Payout is not in FAILED status' })
  @ApiResponse({ status: 404, description: 'Payout not found' })
  async retryPayout(@Param('id') payoutId: string) {
    await this.payoutService.retryFailed(payoutId);
    return { message: 'Payout retry queued successfully' };
  }

  private async resolveProvider(userId: string) {
    const provider = await this.prisma.provider.findUnique({ where: { userId } });
    if (!provider) throw new NotFoundException('Provider profile not found for this user');
    return provider;
  }
}
