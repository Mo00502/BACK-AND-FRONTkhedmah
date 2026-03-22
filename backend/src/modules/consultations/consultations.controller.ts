import { Controller, Get, Post, Patch, Body, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { ConsultationsService } from './consultations.service';
import { CreateConsultationDto } from './dto/create-consultation.dto';
import { RateConsultationDto } from './dto/rate-consultation.dto';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ConsultationStatus, UserRole } from '@prisma/client';
import { ThrottleDefault } from '../../common/decorators/throttle.decorator';

@ApiTags('consultations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('consultations')
export class ConsultationsController {
  constructor(private consultations: ConsultationsService) {}

  // ── Customer endpoints ────────────────────────────────────────────────────

  @Post()
  @Roles(UserRole.CUSTOMER)
  @ThrottleDefault()
  @ApiOperation({ summary: 'Customer: request a consultation session' })
  create(@CurrentUser('id') customerId: string, @Body() dto: CreateConsultationDto) {
    return this.consultations.create(customerId, dto);
  }

  @Get()
  @ThrottleDefault()
  @ApiOperation({ summary: 'List my consultations (customer or provider)' })
  @ApiQuery({ name: 'status', enum: ConsultationStatus, required: false })
  findMine(
    @CurrentUser() user: any,
    @Query() dto: PaginationDto & { status?: ConsultationStatus },
  ) {
    return this.consultations.findMine(user.id, user.role, dto);
  }

  @Get(':id')
  @ThrottleDefault()
  @ApiOperation({ summary: 'Get consultation details' })
  findOne(@Param('id') id: string, @CurrentUser() user: any) {
    return this.consultations.findById(id, user.id, user.role);
  }

  @Patch(':id/cancel')
  @Roles(UserRole.CUSTOMER)
  @ThrottleDefault()
  @ApiOperation({ summary: 'Customer: cancel a pending or accepted consultation' })
  cancel(@Param('id') id: string, @CurrentUser('id') customerId: string) {
    return this.consultations.cancel(customerId, id);
  }

  @Post(':id/rate')
  @Roles(UserRole.CUSTOMER)
  @ThrottleDefault()
  @ApiOperation({ summary: 'Customer: rate a completed consultation (1–5 stars)' })
  rate(
    @Param('id') id: string,
    @CurrentUser('id') customerId: string,
    @Body() dto: RateConsultationDto,
  ) {
    return this.consultations.rate(customerId, id, dto);
  }

  // ── Provider endpoints ────────────────────────────────────────────────────

  @Patch(':id/accept')
  @Roles(UserRole.PROVIDER)
  @ThrottleDefault()
  @ApiOperation({ summary: 'Provider: accept a consultation request' })
  accept(@Param('id') id: string, @CurrentUser('id') providerId: string) {
    return this.consultations.accept(providerId, id);
  }

  @Patch(':id/reject')
  @Roles(UserRole.PROVIDER)
  @ThrottleDefault()
  @ApiOperation({ summary: 'Provider: reject a consultation request' })
  reject(@Param('id') id: string, @CurrentUser('id') providerId: string) {
    return this.consultations.reject(providerId, id);
  }

  @Patch(':id/start')
  @Roles(UserRole.PROVIDER)
  @ThrottleDefault()
  @ApiOperation({ summary: 'Provider: mark session as started' })
  startSession(@Param('id') id: string, @CurrentUser('id') providerId: string) {
    return this.consultations.startSession(providerId, id);
  }

  @Patch(':id/complete')
  @Roles(UserRole.PROVIDER)
  @ThrottleDefault()
  @ApiOperation({ summary: 'Provider: mark session as completed' })
  complete(
    @Param('id') id: string,
    @CurrentUser('id') providerId: string,
    @Body('notes') notes?: string,
  ) {
    return this.consultations.complete(providerId, id, notes);
  }
}
