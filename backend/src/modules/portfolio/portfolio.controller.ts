import { Controller, Get, Post, Delete, Param, Body, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { IsString, IsOptional, IsArray, IsDateString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { PortfolioService } from './portfolio.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import {
  ThrottleRelaxed,
  ThrottleDefault,
  ThrottleStrict,
} from '../../common/decorators/throttle.decorator';
import { UserRole } from '@prisma/client';

class AddPortfolioItemDto {
  @ApiProperty() @IsString() title: string;
  @ApiProperty() @IsString() description: string;
  @ApiProperty({ type: [String] }) @IsArray() imageUrls: string[];
  @ApiProperty({ required: false }) @IsOptional() @IsString() serviceId?: string;
}

class AddCertificationDto {
  @ApiProperty() @IsString() name: string;
  @ApiProperty() @IsString() issuer: string;
  @ApiProperty() @IsDateString() issuedAt: string;
  @ApiProperty({ required: false }) @IsOptional() @IsDateString() expiresAt?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() fileUrl?: string;
}

@ApiTags('portfolio')
@Controller('providers/:providerId')
export class PortfolioController {
  constructor(private portfolio: PortfolioService) {}

  // ── Portfolio ──────────────────────────────────────────────────────────────
  @Public()
  @ThrottleRelaxed()
  @Get('portfolio')
  @ApiOperation({ summary: 'Get provider portfolio items (public)' })
  getPortfolio(@Param('providerId') providerId: string) {
    return this.portfolio.getPortfolio(providerId);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ThrottleDefault()
  @Post('portfolio')
  @ApiOperation({ summary: 'Add portfolio item (provider only)' })
  addItem(@CurrentUser('id') userId: string, @Body() dto: AddPortfolioItemDto) {
    return this.portfolio.addItem(userId, dto.title, dto.description, dto.imageUrls, dto.serviceId);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ThrottleDefault()
  @Delete('portfolio/:itemId')
  @ApiOperation({ summary: 'Remove portfolio item' })
  removeItem(@CurrentUser('id') userId: string, @Param('itemId') itemId: string) {
    return this.portfolio.removeItem(userId, itemId);
  }

  // ── Certifications ─────────────────────────────────────────────────────────
  @Public()
  @ThrottleRelaxed()
  @Get('certifications')
  @ApiOperation({ summary: 'Get provider certifications (public)' })
  getCerts(@Param('providerId') providerId: string) {
    return this.portfolio.getCertifications(providerId);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ThrottleDefault()
  @Post('certifications')
  @ApiOperation({ summary: 'Add certification (provider only)' })
  addCert(@CurrentUser('id') userId: string, @Body() dto: AddCertificationDto) {
    return this.portfolio.addCertification(
      userId,
      dto.name,
      dto.issuer,
      new Date(dto.issuedAt),
      dto.expiresAt ? new Date(dto.expiresAt) : undefined,
      dto.fileUrl,
    );
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ThrottleDefault()
  @Delete('certifications/:certId')
  @ApiOperation({ summary: 'Remove certification' })
  removeCert(@CurrentUser('id') userId: string, @Param('certId') certId: string) {
    return this.portfolio.removeCertification(userId, certId);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @ThrottleStrict()
  @Post('certifications/:certId/verify')
  @ApiOperation({ summary: 'Admin: mark certification as verified' })
  verifyCert(@Param('certId') certId: string) {
    return this.portfolio.verifyCertification(certId);
  }
}
