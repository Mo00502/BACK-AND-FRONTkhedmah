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
import { ProvidersService } from './providers.service';
import { UpdateProviderDto, AddSkillDto, SetAvailabilityDto } from './dto/update-provider.dto';
import { PaginationDto } from '../../common/dto/pagination.dto';
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
import { IsArray, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

class SubmitDocsDto {
  @ApiProperty({ type: [String], example: ['docs/id-card.pdf', 'docs/cert.jpg'] })
  @IsArray()
  @IsString({ each: true })
  docKeys: string[];
}

@ApiTags('providers')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('providers')
export class ProvidersController {
  constructor(private providers: ProvidersService) {}

  @Public()
  @ThrottleRelaxed()
  @Get()
  @ApiOperation({ summary: 'List all providers (public)' })
  findAll(@Query() dto: PaginationDto & { serviceId?: string; city?: string }) {
    return this.providers.findAll(dto);
  }

  @ApiBearerAuth()
  @Patch('me/profile')
  @Roles(UserRole.PROVIDER)
  @ThrottleDefault()
  @ApiOperation({ summary: 'Update provider profile (IBAN, experience, etc.)' })
  updateProfile(@CurrentUser('id') userId: string, @Body() dto: UpdateProviderDto) {
    return this.providers.upsertProfile(userId, dto);
  }

  @ApiBearerAuth()
  @Post('me/skills')
  @Roles(UserRole.PROVIDER)
  @ThrottleDefault()
  @ApiOperation({ summary: 'Add a skill/service to provider profile' })
  addSkill(@CurrentUser('id') userId: string, @Body() dto: AddSkillDto) {
    return this.providers.addSkill(userId, dto);
  }

  @ApiBearerAuth()
  @Delete('me/skills/:skillId')
  @Roles(UserRole.PROVIDER)
  @ThrottleDefault()
  @ApiOperation({ summary: 'Remove a skill from provider profile' })
  removeSkill(@CurrentUser('id') userId: string, @Param('skillId') skillId: string) {
    return this.providers.removeSkill(userId, skillId);
  }

  @ApiBearerAuth()
  @Patch('me/skills/:skillId')
  @Roles(UserRole.PROVIDER)
  @ThrottleDefault()
  @ApiOperation({ summary: 'Update a skill (hourlyRate)' })
  updateSkill(
    @Param('skillId') skillId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: { hourlyRate?: number },
  ) {
    return this.providers.updateSkill(userId, skillId, dto);
  }

  @ApiBearerAuth()
  @Patch('me/availability')
  @Roles(UserRole.PROVIDER)
  @ThrottleDefault()
  @ApiOperation({ summary: 'Set weekly availability schedule' })
  setAvailability(@CurrentUser('id') userId: string, @Body() dto: SetAvailabilityDto) {
    return this.providers.setAvailability(userId, dto);
  }

  @ApiBearerAuth()
  @Get('me/profile')
  @Roles(UserRole.PROVIDER)
  @ThrottleRelaxed()
  @ApiOperation({ summary: 'Get my provider profile' })
  getMyProfile(@CurrentUser('id') userId: string) {
    return this.providers.getMyProfile(userId);
  }

  @ApiBearerAuth()
  @Get('me/skills')
  @Roles(UserRole.PROVIDER)
  @ThrottleRelaxed()
  @ApiOperation({ summary: 'Get my skills/services' })
  getMySkills(@CurrentUser('id') userId: string) {
    return this.providers.getMySkills(userId);
  }

  @ApiBearerAuth()
  @Get('me/availability')
  @Roles(UserRole.PROVIDER)
  @ThrottleRelaxed()
  @ApiOperation({ summary: 'Get my availability schedule' })
  getMyAvailability(@CurrentUser('id') userId: string) {
    return this.providers.getMyAvailability(userId);
  }

  @ApiBearerAuth()
  @Get('me/earnings')
  @Roles(UserRole.PROVIDER)
  @ThrottleRelaxed()
  @ApiOperation({ summary: 'Get earnings summary (available, pending, total)' })
  getEarnings(@CurrentUser('id') userId: string) {
    return this.providers.getEarnings(userId);
  }

  @ApiBearerAuth()
  @Get('me/earnings/dashboard')
  @Roles(UserRole.PROVIDER)
  @ThrottleRelaxed()
  @ApiOperation({
    summary:
      'Full earnings dashboard — weekly/monthly trend, commission breakdown, per-job history',
  })
  getEarningsDashboard(@CurrentUser('id') userId: string) {
    return this.providers.getEarningsDashboard(userId);
  }

  // ── Provider onboarding & verification ────────────────────────────────────

  @ApiBearerAuth()
  @Get('me/verification')
  @Roles(UserRole.PROVIDER)
  @ThrottleRelaxed()
  @ApiOperation({ summary: 'Get own verification status and timeline' })
  getVerificationStatus(@CurrentUser('id') userId: string) {
    return this.providers.getVerificationStatus(userId);
  }

  @ApiBearerAuth()
  @Post('me/documents')
  @Roles(UserRole.PROVIDER)
  @HttpCode(HttpStatus.OK)
  @ThrottleStrict()
  @ApiOperation({
    summary: 'Submit verification documents (S3 keys) — moves status to PENDING_REVIEW',
  })
  submitDocuments(@CurrentUser('id') userId: string, @Body() dto: SubmitDocsDto) {
    return this.providers.submitDocuments(userId, dto.docKeys);
  }

  @Public()
  @ThrottleRelaxed()
  @Get(':userId')
  @ApiOperation({ summary: 'Get provider public profile' })
  findOne(@Param('userId') userId: string) {
    return this.providers.findByUserId(userId);
  }
}
