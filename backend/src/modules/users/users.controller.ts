import {
  Controller,
  Get,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
  ForbiddenException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { IsString, IsOptional } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { UsersService } from './users.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
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
import { UserRole } from '@prisma/client';

class SuspendUserDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  reason?: string;
}

@ApiTags('users')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('users')
export class UsersController {
  constructor(private users: UsersService) {}

  @Get()
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @ThrottleRelaxed()
  @ApiOperation({ summary: 'List all users (admin only)' })
  findAll(@Query() dto: PaginationDto) {
    return this.users.findAll(dto);
  }

  @Get('me')
  @ThrottleDefault()
  @ApiOperation({ summary: 'Get current user profile' })
  getMe(@CurrentUser() user: any) {
    return this.users.findById(user.id);
  }

  @Get('me/stats')
  @ThrottleDefault()
  @ApiOperation({ summary: 'Get current user statistics' })
  getMyStats(@CurrentUser('id') userId: string) {
    return this.users.getMyStats(userId);
  }

  @Patch('me/profile')
  @ThrottleDefault()
  @ApiOperation({ summary: 'Update current user profile' })
  updateProfile(@CurrentUser('id') userId: string, @Body() dto: UpdateProfileDto) {
    return this.users.updateProfile(userId, dto);
  }

  @Get(':id')
  @ThrottleDefault()
  @ApiOperation({ summary: 'Get user by ID (self or admin only)' })
  findOne(@Param('id') id: string, @CurrentUser() currentUser: any) {
    const isAdmin = currentUser.role === UserRole.ADMIN || currentUser.role === UserRole.SUPER_ADMIN;
    if (currentUser.id !== id && !isAdmin) {
      throw new ForbiddenException('Access denied');
    }
    return this.users.findById(id);
  }

  @Patch(':id/suspend')
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @ThrottleStrict()
  @ApiOperation({ summary: 'Suspend a user (admin only)' })
  suspend(
    @CurrentUser('id') adminId: string,
    @Param('id') targetId: string,
    @Body() dto: SuspendUserDto,
  ) {
    return this.users.suspend(adminId, targetId, dto.reason);
  }

  @Patch(':id/ban')
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @ThrottleStrict()
  @ApiOperation({ summary: 'Ban a user (admin only)' })
  ban(@CurrentUser('id') adminId: string, @Param('id') targetId: string) {
    return this.users.ban(adminId, targetId);
  }

  @Delete('me')
  @HttpCode(HttpStatus.OK)
  @ThrottleStrict()
  @ApiOperation({ summary: 'Request account closure — soft-deletes and revokes all sessions' })
  deleteMe(@CurrentUser('id') userId: string) {
    return this.users.selfDelete(userId);
  }
}
