import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { TendersService } from './tenders.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import {
  ThrottleDefault,
  ThrottleRelaxed,
  ThrottleStrict,
} from '../../common/decorators/throttle.decorator';
import { UserRole, CommissionStatus } from '@prisma/client';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { IsEnum } from 'class-validator';

class UpdateCommissionStatusDto {
  @IsEnum(CommissionStatus)
  status: CommissionStatus;
}

@ApiTags('tenders')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('tenders')
export class TendersController {
  constructor(private tenders: TendersService) {}

  // ── Tenders ──────────────────────────────────────────────────────────────

  @Get()
  @Public()
  @ThrottleRelaxed()
  @ApiOperation({ summary: 'List open tenders (no bid counts exposed)' })
  list(
    @Query('status') status?: string,
    @Query('category') category?: string,
    @Query('region') region?: string,
    @Query() pagination?: PaginationDto,
  ) {
    return this.tenders.list({ status, category, region }, pagination);
  }

  @Get('my-bids')
  @ThrottleRelaxed()
  @ApiOperation({ summary: 'Get my submitted bids' })
  myBids(@CurrentUser() user: any, @Query() pagination?: PaginationDto) {
    return this.tenders.myBids(user.id, pagination);
  }

  /**
   * Commission endpoints — admin only.
   * Any authenticated user reaching these gets a 403.
   */
  @Get('commissions')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @ThrottleRelaxed()
  @ApiOperation({ summary: 'List all commissions (admin only)' })
  commissions(@Query('status') status?: string, @Query() pagination?: PaginationDto) {
    return this.tenders.listCommissions({ status }, pagination);
  }

  @Get(':id')
  @Public()
  @ThrottleRelaxed()
  @ApiOperation({
    summary: 'Get tender detail — caller sees only their own bid, never competitors',
  })
  get(@Param('id') id: string, @CurrentUser() user: any) {
    return this.tenders.get(id, user?.id);
  }

  /**
   * Returns ALL bids for a tender — restricted to the tender owner only.
   * Bidders cannot access this endpoint for competitor data.
   */
  @Get(':id/bids')
  @ThrottleRelaxed()
  @ApiOperation({ summary: 'List all bids (tender owner only)' })
  listBids(@Param('id') id: string, @CurrentUser() user: any, @Query() pagination?: PaginationDto) {
    return this.tenders.listBids(id, user.id, pagination);
  }

  @Post()
  @ThrottleStrict()
  @ApiOperation({ summary: 'Post a new tender' })
  create(@CurrentUser() user: any, @Body() body: Record<string, any>) {
    return this.tenders.create(user.id, body);
  }

  // ── Bids ─────────────────────────────────────────────────────────────────

  @Post(':id/bids')
  @ThrottleDefault()
  @ApiOperation({ summary: 'Submit a bid — validates deadline, status, and prevents self-bidding' })
  submitBid(@Param('id') id: string, @CurrentUser() user: any, @Body() body: Record<string, any>) {
    return this.tenders.submitBid(id, user.id, body);
  }

  @Patch(':id/bids/:bidId')
  @ThrottleDefault()
  @ApiOperation({ summary: 'Update own bid before deadline' })
  updateBid(
    @Param('id') tenderId: string,
    @Param('bidId') bidId: string,
    @CurrentUser() user: any,
    @Body() body: { amount?: number; durationMonths?: number; note?: string },
  ) {
    return this.tenders.updateBid(tenderId, bidId, user.id, body);
  }

  @Delete(':id/bids/:bidId')
  @HttpCode(HttpStatus.OK)
  @ThrottleDefault()
  @ApiOperation({ summary: 'Withdraw own bid before deadline' })
  withdrawBid(@Param('id') tenderId: string, @Param('bidId') bidId: string, @CurrentUser() user: any) {
    return this.tenders.withdrawBid(tenderId, bidId, user.id);
  }

  @Post(':id/award/:bidId')
  @HttpCode(HttpStatus.OK)
  @ThrottleStrict()
  @ApiOperation({ summary: 'Award a tender to a winning bid (tender owner only)' })
  award(@Param('id') id: string, @Param('bidId') bidId: string, @CurrentUser() user: any) {
    return this.tenders.award(id, bidId, user.id);
  }

  @Patch('commissions/:id/status')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @ThrottleDefault()
  @ApiOperation({ summary: 'Update commission lifecycle status (admin only)' })
  updateCommissionStatus(@Param('id') id: string, @Body() dto: UpdateCommissionStatusDto) {
    return this.tenders.updateCommissionStatus(id, dto.status);
  }

  // ── Requirements ─────────────────────────────────────────────────────────

  @Post(':tenderId/requirements')
  @ThrottleDefault()
  @ApiOperation({ summary: 'Add project requirement (tender owner only)' })
  createRequirement(
    @Param('tenderId') tenderId: string,
    @CurrentUser() user: any,
    @Body() body: Record<string, any>,
  ) {
    return this.tenders.createRequirement(tenderId, user.id, body);
  }

  @Get(':tenderId/requirements')
  @ThrottleRelaxed()
  @ApiOperation({ summary: 'List project requirements for a tender' })
  listRequirements(@Param('tenderId') tenderId: string) {
    return this.tenders.listRequirements(tenderId);
  }

  // ── Supplier Offers ───────────────────────────────────────────────────────

  @Post('requirements/:requirementId/offers')
  @ThrottleDefault()
  @ApiOperation({ summary: 'Submit a supplier offer for a project requirement' })
  submitOffer(
    @Param('requirementId') reqId: string,
    @CurrentUser() user: any,
    @Body() body: Record<string, any>,
  ) {
    return this.tenders.submitOffer(reqId, user.id, body);
  }

  @Post('requirements/:requirementId/offers/:offerId/select')
  @HttpCode(HttpStatus.OK)
  @ThrottleStrict()
  @ApiOperation({ summary: 'Select winning supplier offer (tender owner only)' })
  selectOffer(
    @Param('offerId') offerId: string,
    @Param('requirementId') reqId: string,
    @CurrentUser() user: any,
  ) {
    return this.tenders.selectOffer(offerId, reqId, user.id);
  }
}
