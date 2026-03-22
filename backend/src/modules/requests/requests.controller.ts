import { Controller, Get, Post, Patch, Body, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { RequestsService } from './requests.service';
import { CreateRequestDto } from './dto/create-request.dto';
import { CreateQuoteDto } from './dto/create-quote.dto';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import {
  ThrottleDefault,
  ThrottleRelaxed,
  ThrottleStrict,
} from '../../common/decorators/throttle.decorator';
import { UserRole, RequestStatus } from '@prisma/client';

@ApiTags('requests')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('requests')
export class RequestsController {
  constructor(private requests: RequestsService) {}

  @ThrottleDefault()
  @Post()
  @Roles(UserRole.CUSTOMER)
  @ApiOperation({ summary: 'Create a new service request' })
  create(@CurrentUser('id') customerId: string, @Body() dto: CreateRequestDto) {
    return this.requests.create(customerId, dto);
  }

  @ThrottleRelaxed()
  @Get()
  @ApiOperation({ summary: 'List my requests (customer or provider)' })
  @ApiQuery({ name: 'status', enum: RequestStatus, required: false })
  findMine(@CurrentUser() user: any, @Query() dto: PaginationDto & { status?: RequestStatus }) {
    return this.requests.findMyRequests(user.id, user.role, dto);
  }

  @ThrottleRelaxed()
  @Get(':id')
  @ApiOperation({ summary: 'Get request details' })
  findOne(@Param('id') id: string, @CurrentUser() user: any) {
    return this.requests.findById(id, user.id, user.role);
  }

  @ThrottleDefault()
  @Patch(':id/cancel')
  @Roles(UserRole.CUSTOMER)
  @ApiOperation({ summary: 'Cancel a pending or quoted request' })
  cancel(@Param('id') id: string, @CurrentUser('id') customerId: string) {
    return this.requests.cancel(id, customerId);
  }

  @ThrottleDefault()
  @Post(':id/quotes')
  @Roles(UserRole.PROVIDER)
  @ApiOperation({ summary: 'Submit a quote for a service request' })
  submitQuote(
    @Param('id') requestId: string,
    @CurrentUser('id') providerId: string,
    @Body() dto: CreateQuoteDto,
  ) {
    return this.requests.submitQuote(providerId, requestId, dto);
  }

  @ThrottleStrict()
  @Patch(':id/quotes/:quoteId/accept')
  @Roles(UserRole.CUSTOMER)
  @ApiOperation({ summary: 'Accept a provider quote' })
  acceptQuote(
    @Param('id') requestId: string,
    @Param('quoteId') quoteId: string,
    @CurrentUser('id') customerId: string,
  ) {
    return this.requests.acceptQuote(customerId, requestId, quoteId);
  }

  @ThrottleDefault()
  @Patch(':id/start')
  @Roles(UserRole.PROVIDER)
  @ApiOperation({ summary: 'Provider marks work as started (ACCEPTED → IN_PROGRESS)' })
  startWork(@Param('id') requestId: string, @CurrentUser('id') providerId: string) {
    return this.requests.startWork(providerId, requestId);
  }

  @ThrottleDefault()
  @Patch(':id/complete')
  @Roles(UserRole.PROVIDER)
  @ApiOperation({ summary: 'Provider marks work as completed (IN_PROGRESS → COMPLETED)' })
  completeWork(@Param('id') requestId: string, @CurrentUser('id') providerId: string) {
    return this.requests.completeWork(providerId, requestId);
  }
}
