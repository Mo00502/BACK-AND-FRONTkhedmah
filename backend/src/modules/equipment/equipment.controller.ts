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
import { EquipmentService } from './equipment.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ThrottleDefault, ThrottleRelaxed } from '../../common/decorators/throttle.decorator';

@ApiTags('equipment')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('equipment')
export class EquipmentController {
  constructor(private equipment: EquipmentService) {}

  // ── Marketplace browse ────────────────────────────────────────────────────

  /**
   * Global marketplace feed. Returns active public listings with provider card.
   * Supports filtering by category, region, city, rentalType, price range,
   * availability, and keyword search (name, description, brand, model).
   */
  @Get()
  @ThrottleRelaxed()
  @ApiOperation({ summary: 'Browse equipment marketplace — dual-discovery Layer 1' })
  search(
    @Query('category') category?: string,
    @Query('region') region?: string,
    @Query('city') city?: string,
    @Query('q') q?: string,
    @Query('available') available?: string,
    @Query('rentalType') rentalType?: string,
    @Query('minPrice') minPrice?: string,
    @Query('maxPrice') maxPrice?: string,
  ) {
    return this.equipment.search({
      category,
      region,
      city,
      q,
      available: available === 'true' ? true : available === 'false' ? false : undefined,
      rentalType: rentalType as any,
      minPrice: minPrice ? Number(minPrice) : undefined,
      maxPrice: maxPrice ? Number(maxPrice) : undefined,
    });
  }

  /**
   * Provider storefront — all active listings from one provider.
   * This is dual-discovery Layer 2: browsing by provider profile.
   */
  @Get('providers/:ownerId')
  @ThrottleRelaxed()
  @ApiOperation({
    summary: 'Provider storefront — profile + all listings (dual-discovery Layer 2)',
  })
  getProviderProfile(@Param('ownerId') ownerId: string) {
    return this.equipment.getProviderProfile(ownerId);
  }

  @Get('mine')
  @ThrottleRelaxed()
  @ApiOperation({ summary: 'My equipment listings (owner dashboard)' })
  mine(@CurrentUser() user: any) {
    return this.equipment.listMine(user.id);
  }

  @Get('rentals/mine')
  @ThrottleRelaxed()
  @ApiOperation({ summary: 'My rental history' })
  myRentals(@CurrentUser() user: any) {
    return this.equipment.myRentals(user.id);
  }

  @Get('inquiries/mine')
  @ThrottleRelaxed()
  @ApiOperation({ summary: 'All inquiries I have sent' })
  myInquiries(@CurrentUser() user: any) {
    return this.equipment.myInquiries(user.id);
  }

  @Get(':id')
  @ThrottleRelaxed()
  @ApiOperation({ summary: 'Equipment detail — includes provider card + booked dates' })
  get(@Param('id') id: string) {
    return this.equipment.get(id);
  }

  // ── Listing management ────────────────────────────────────────────────────

  @Post()
  @ThrottleDefault()
  @ApiOperation({ summary: 'Create equipment listing (goes to pending review)' })
  create(@CurrentUser() user: any, @Body() body: Record<string, any>) {
    return this.equipment.create(user.id, body);
  }

  @Patch(':id')
  @ThrottleDefault()
  @ApiOperation({ summary: 'Update equipment listing' })
  update(@Param('id') id: string, @CurrentUser() user: any, @Body() body: Record<string, any>) {
    return this.equipment.update(id, user.id, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ThrottleDefault()
  @ApiOperation({ summary: 'Archive (soft-delete) equipment listing' })
  remove(@Param('id') id: string, @CurrentUser() user: any) {
    return this.equipment.remove(id, user.id);
  }

  // ── Inquiries ─────────────────────────────────────────────────────────────

  @Post(':id/inquiries')
  @ThrottleDefault()
  @ApiOperation({ summary: 'Send rental inquiry to equipment owner' })
  submitInquiry(
    @Param('id') id: string,
    @CurrentUser() user: any,
    @Body() body: { message: string; phone?: string },
  ) {
    return this.equipment.submitInquiry(id, user.id, body);
  }

  @Get(':id/inquiries')
  @ThrottleRelaxed()
  @ApiOperation({ summary: 'View all inquiries for a listing (owner only)' })
  listInquiries(@Param('id') id: string, @CurrentUser() user: any) {
    return this.equipment.listInquiries(id, user.id);
  }

  @Patch('inquiries/:inquiryId/status')
  @ThrottleDefault()
  @ApiOperation({ summary: 'Mark inquiry as replied or closed (owner only)' })
  updateInquiryStatus(
    @Param('inquiryId') inquiryId: string,
    @CurrentUser() user: any,
    @Body('status') status: 'REPLIED' | 'CLOSED',
  ) {
    return this.equipment.updateInquiryStatus(inquiryId, user.id, status);
  }

  // ── Rentals ───────────────────────────────────────────────────────────────

  @Post(':id/rentals')
  @ThrottleDefault()
  @ApiOperation({ summary: 'Book equipment rental' })
  createRental(
    @Param('id') id: string,
    @CurrentUser() user: any,
    @Body() body: Record<string, any>,
  ) {
    return this.equipment.createRental(id, user.id, body);
  }

  @Patch('rentals/:id/status')
  @ThrottleDefault()
  @ApiOperation({
    summary: 'Update rental status — owner: confirm/complete; renter or owner: cancel',
  })
  updateRentalStatus(
    @Param('id') id: string,
    @CurrentUser() user: any,
    @Body('status') status: string,
  ) {
    return this.equipment.updateRentalStatus(id, status, user.id);
  }
}
