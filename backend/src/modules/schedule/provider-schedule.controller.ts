import { Controller, Get, Post, Put, Delete, Param, Body, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { IsString, IsBoolean, IsOptional, IsArray, IsEnum, IsDateString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { ProviderScheduleService } from './provider-schedule.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { ThrottleRelaxed, ThrottleDefault } from '../../common/decorators/throttle.decorator';

class DayScheduleDto {
  @ApiProperty() @IsString() dayOfWeek: string;
  @ApiProperty() @IsString() startTime: string;
  @ApiProperty() @IsString() endTime: string;
  @ApiProperty() @IsBoolean() isWorking: boolean;
}

class BulkScheduleDto {
  @ApiProperty({ type: [DayScheduleDto] })
  @IsArray()
  days: DayScheduleDto[];
}

class AddVacationDto {
  @ApiProperty() @IsDateString() startDate: string;
  @ApiProperty() @IsDateString() endDate: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() reason?: string;
}

class ApplyPresetDto {
  @ApiProperty({ enum: ['FULL_TIME', 'MORNING', 'EVENING'] })
  @IsEnum(['FULL_TIME', 'MORNING', 'EVENING'])
  preset: 'FULL_TIME' | 'MORNING' | 'EVENING';
}

@ApiTags('schedule')
@Controller('providers/:providerId/schedule')
export class ProviderScheduleController {
  constructor(private scheduleService: ProviderScheduleService) {}

  @Public()
  @ThrottleRelaxed()
  @Get()
  @ApiOperation({ summary: 'Get provider weekly schedule (public)' })
  getSchedule(@Param('providerId') providerId: string) {
    return this.scheduleService.getSchedule(providerId);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ThrottleDefault()
  @Put('bulk')
  @ApiOperation({ summary: 'Save full weekly schedule at once' })
  bulkSet(
    @CurrentUser('id') userId: string,
    @Param('providerId') providerId: string,
    @Body() dto: BulkScheduleDto,
  ) {
    return this.scheduleService.bulkSetSchedule(userId, providerId, dto.days);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ThrottleDefault()
  @Put('day/:day')
  @ApiOperation({ summary: 'Update a single day schedule' })
  setDay(
    @CurrentUser('id') userId: string,
    @Param('providerId') providerId: string,
    @Param('day') day: string,
    @Body() dto: DayScheduleDto,
  ) {
    return this.scheduleService.setDaySchedule(
      userId,
      providerId,
      day,
      dto.startTime,
      dto.endTime,
      dto.isWorking,
    );
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ThrottleDefault()
  @Post('preset')
  @ApiOperation({ summary: 'Apply a time preset (FULL_TIME | MORNING | EVENING)' })
  applyPreset(
    @CurrentUser('id') userId: string,
    @Param('providerId') providerId: string,
    @Body() dto: ApplyPresetDto,
  ) {
    return this.scheduleService.applyPreset(userId, providerId, dto.preset);
  }

  @Public()
  @ThrottleRelaxed()
  @Get('vacations')
  @ApiOperation({ summary: 'Get upcoming provider vacations (public)' })
  getVacations(@Param('providerId') providerId: string) {
    return this.scheduleService.getVacations(providerId);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ThrottleDefault()
  @Post('vacations')
  @ApiOperation({ summary: 'Add a vacation/unavailable period' })
  addVacation(
    @CurrentUser('id') userId: string,
    @Param('providerId') providerId: string,
    @Body() dto: AddVacationDto,
  ) {
    return this.scheduleService.addVacation(
      userId,
      providerId,
      new Date(dto.startDate),
      new Date(dto.endDate),
      dto.reason,
    );
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ThrottleDefault()
  @Delete('vacations/:vacationId')
  @ApiOperation({ summary: 'Remove a vacation period' })
  removeVacation(@CurrentUser('id') userId: string, @Param('vacationId') vacationId: string) {
    return this.scheduleService.removeVacation(userId, vacationId);
  }

  @Public()
  @ThrottleRelaxed()
  @Get('available')
  @ApiOperation({ summary: 'Check if provider is available on a specific date' })
  checkAvailability(@Param('providerId') providerId: string, @Query('date') date: string) {
    return this.scheduleService.isAvailableOn(providerId, new Date(date));
  }
}
