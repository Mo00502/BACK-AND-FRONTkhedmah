import { Controller, Get, Post, Patch, Param, Body, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { IsString, IsEnum, IsOptional, IsArray } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { SupportService, TicketCategory, TicketPriority } from './support.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import {
  ThrottleStrict,
  ThrottleDefault,
  ThrottleRelaxed,
} from '../../common/decorators/throttle.decorator';
import { UserRole } from '@prisma/client';

const CATEGORIES = [
  'PAYMENT',
  'PROVIDER_ISSUE',
  'SERVICE_QUALITY',
  'ACCOUNT',
  'TECHNICAL',
  'OTHER',
] as const;
const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const;

class OpenTicketDto {
  @ApiProperty() @IsString() subject: string;
  @ApiProperty() @IsString() description: string;
  @ApiProperty({ enum: CATEGORIES }) @IsEnum(CATEGORIES) category: TicketCategory;
  @ApiProperty({ enum: PRIORITIES, required: false })
  @IsOptional()
  @IsEnum(PRIORITIES)
  priority?: TicketPriority;
  @ApiProperty({ type: [String], required: false }) @IsOptional() @IsArray() attachments?: string[];
  @ApiProperty({ required: false }) @IsOptional() @IsString() relatedRequestId?: string;
}

class AddMessageDto {
  @ApiProperty() @IsString() content: string;
}

class UpdateStatusDto {
  @ApiProperty({ enum: ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'] })
  @IsEnum(['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'])
  status: string;
}

class AssignDto {
  @ApiProperty() @IsString() assigneeId: string;
}

@ApiTags('support')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('support')
export class SupportController {
  constructor(private support: SupportService) {}

  // ── Customer endpoints ─────────────────────────────────────────────────────
  @ThrottleRelaxed()
  @Get('tickets')
  @ApiOperation({ summary: 'List my support tickets' })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  listMine(
    @CurrentUser('id') userId: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.support.listMine(
      userId,
      status,
      page ? Math.max(1, parseInt(page, 10) || 1) : 1,
      limit ? Math.min(50, Math.max(1, parseInt(limit, 10) || 20)) : 20,
    );
  }

  @ThrottleStrict()
  @Post('tickets')
  @ApiOperation({ summary: 'Open a new support ticket' })
  open(@CurrentUser('id') userId: string, @Body() dto: OpenTicketDto) {
    return this.support.openTicket(
      userId,
      dto.subject,
      dto.description,
      dto.category,
      dto.priority,
      dto.attachments,
      dto.relatedRequestId,
    );
  }

  @ThrottleRelaxed()
  @Get('tickets/:ticketId')
  @ApiOperation({ summary: 'Get ticket details and messages' })
  getTicket(@CurrentUser('id') userId: string, @Param('ticketId') ticketId: string) {
    return this.support.getTicket(userId, ticketId, false);
  }

  @ThrottleStrict()
  @Post('tickets/:ticketId/messages')
  @ApiOperation({ summary: 'Add a reply to a ticket' })
  addMessage(
    @CurrentUser('id') userId: string,
    @Param('ticketId') ticketId: string,
    @Body() dto: AddMessageDto,
  ) {
    return this.support.addMessage(userId, ticketId, dto.content, false);
  }

  // ── Admin / Support staff endpoints ───────────────────────────────────────
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN, UserRole.SUPPORT)
  @ThrottleRelaxed()
  @Get('admin/tickets')
  @ApiOperation({ summary: 'Admin: list all tickets with filters' })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'priority', required: false })
  @ApiQuery({ name: 'category', required: false })
  @ApiQuery({ name: 'assigneeId', required: false })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  adminList(
    @Query('status') status?: string,
    @Query('priority') priority?: string,
    @Query('category') category?: string,
    @Query('assigneeId') assigneeId?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.support.adminList({
      status,
      priority,
      category,
      assigneeId,
      page:  page  ? Math.max(1, parseInt(page, 10)  || 1)  : 1,
      limit: limit ? Math.min(100, Math.max(1, parseInt(limit, 10) || 20)) : 20,
    });
  }

  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN, UserRole.SUPPORT)
  @ThrottleRelaxed()
  @Get('admin/tickets/:ticketId')
  @ApiOperation({ summary: 'Admin: get full ticket detail' })
  adminGetTicket(@CurrentUser('id') userId: string, @Param('ticketId') ticketId: string) {
    return this.support.getTicket(userId, ticketId, true);
  }

  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN, UserRole.SUPPORT)
  @ThrottleDefault()
  @Post('admin/tickets/:ticketId/messages')
  @ApiOperation({ summary: 'Admin: reply to a ticket' })
  adminReply(
    @CurrentUser('id') userId: string,
    @Param('ticketId') ticketId: string,
    @Body() dto: AddMessageDto,
  ) {
    return this.support.addMessage(userId, ticketId, dto.content, true);
  }

  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN, UserRole.SUPPORT)
  @ThrottleDefault()
  @Patch('admin/tickets/:ticketId/assign')
  @ApiOperation({ summary: 'Admin: assign ticket to staff member' })
  assign(@Param('ticketId') ticketId: string, @Body() dto: AssignDto) {
    return this.support.assignTicket(ticketId, dto.assigneeId);
  }

  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN, UserRole.SUPPORT)
  @ThrottleDefault()
  @Patch('admin/tickets/:ticketId/status')
  @ApiOperation({ summary: 'Admin: update ticket status' })
  updateStatus(@Param('ticketId') ticketId: string, @Body() dto: UpdateStatusDto) {
    return this.support.updateStatus(ticketId, dto.status);
  }

  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @ThrottleRelaxed()
  @Get('admin/sla')
  @ApiOperation({ summary: 'Admin: SLA metrics (open, urgent, avg resolution time)' })
  getSla() {
    return this.support.getSlaMetrics();
  }
}
