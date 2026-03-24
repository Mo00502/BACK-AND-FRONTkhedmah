import { Controller, Get, Post, Body, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { IsString, IsNotEmpty, MinLength, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { RewardsService } from './rewards.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ThrottleRelaxed, ThrottleStrict } from '../../common/decorators/throttle.decorator';

class ApplyCodeDto {
  @ApiProperty({ example: 'ABC123' })
  @IsString()
  @IsNotEmpty()
  @MinLength(4)
  @MaxLength(20)
  code: string;
}

@ApiTags('rewards')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('rewards')
export class RewardsController {
  constructor(private rewards: RewardsService) {}

  @ThrottleRelaxed()
  @Get('referral')
  @ApiOperation({ summary: 'Get my referral code + stats' })
  myReferrals(@CurrentUser() user: any) {
    return this.rewards.myReferrals(user.id);
  }

  @ThrottleStrict()
  @Post('referral/apply')
  @ApiOperation({ summary: 'Apply a referral code (called after signup)' })
  apply(@CurrentUser() user: any, @Body() dto: ApplyCodeDto) {
    return this.rewards.applyCode(user.id, dto.code);
  }
}
