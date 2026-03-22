import { Controller, Get, Post, Patch, Param, Body, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import {
  IsString,
  IsEnum,
  IsNumber,
  IsOptional,
  IsBoolean,
  IsDateString,
  IsArray,
  Min,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { PromotionsService, CreatePromoDto } from './promotions.service';
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
import { UserRole } from '@prisma/client';

class CreatePromoBodyDto implements CreatePromoDto {
  @ApiProperty() @IsString() code: string;
  @ApiProperty({ enum: ['PERCENT', 'FIXED'] }) @IsEnum(['PERCENT', 'FIXED']) type:
    | 'PERCENT'
    | 'FIXED';
  @ApiProperty() @IsNumber() @Min(0) value: number;
  @ApiProperty({ required: false }) @IsOptional() @IsNumber() minOrderAmount?: number;
  @ApiProperty({ required: false }) @IsOptional() @IsNumber() maxDiscountAmount?: number;
  @ApiProperty({ required: false }) @IsOptional() @IsNumber() usageLimit?: number;
  @ApiProperty({ required: false }) @IsOptional() @IsNumber() perUserLimit?: number;
  @ApiProperty({ required: false }) @IsOptional() @IsDateString() expiresAt?: Date;
  @ApiProperty({ required: false, type: [String] }) @IsOptional() @IsArray() serviceIds?: string[];
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() newUsersOnly?: boolean;
  @ApiProperty({ required: false }) @IsOptional() @IsString() description?: string;
}

class ValidateCodeDto {
  @ApiProperty() @IsString() code: string;
  @ApiProperty() @IsNumber() orderAmount: number;
  @ApiProperty({ required: false }) @IsOptional() @IsString() serviceId?: string;
}

@ApiTags('promotions')
@Controller('promotions')
export class PromotionsController {
  constructor(private promos: PromotionsService) {}

  // ── Public: validate a code before checkout ────────────────────────────────
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ThrottleDefault()
  @Post('validate')
  @ApiOperation({ summary: 'Validate a promo code before checkout' })
  validate(@CurrentUser('id') userId: string, @Body() dto: ValidateCodeDto) {
    return this.promos.validateCode(userId, dto.code, dto.orderAmount, dto.serviceId);
  }

  // ── Admin endpoints ────────────────────────────────────────────────────────
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @ThrottleRelaxed()
  @Get()
  @ApiOperation({ summary: 'Admin: list all promo codes' })
  @ApiQuery({ name: 'activeOnly', required: false, type: Boolean })
  listAll(@Query('activeOnly') activeOnly = 'true') {
    return this.promos.listAll(activeOnly !== 'false');
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @ThrottleStrict()
  @Post()
  @ApiOperation({ summary: 'Admin: create promo code' })
  create(@Body() dto: CreatePromoBodyDto) {
    return this.promos.createPromo(dto);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @ThrottleStrict()
  @Patch(':promoId/deactivate')
  @ApiOperation({ summary: 'Admin: deactivate a promo code' })
  deactivate(@Param('promoId') promoId: string) {
    return this.promos.deactivate(promoId);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @ThrottleRelaxed()
  @Get(':promoId/stats')
  @ApiOperation({ summary: 'Admin: promo redemption stats' })
  getStats(@Param('promoId') promoId: string) {
    return this.promos.getStats(promoId);
  }
}
