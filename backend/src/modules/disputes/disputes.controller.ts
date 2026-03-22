import { Controller, Get, Post, Patch, Param, Body, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { IsString, IsOptional, IsArray } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { DisputesService } from './disputes.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import {
  ThrottleStrict,
  ThrottleDefault,
  ThrottleRelaxed,
} from '../../common/decorators/throttle.decorator';

class OpenDisputeDto {
  @ApiProperty() @IsString() requestId: string;
  @ApiProperty() @IsString() reason: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() details?: string;
  @ApiProperty({ required: false, type: [String] }) @IsOptional() @IsArray() evidence?: string[];
}

class AddEvidenceDto {
  @ApiProperty({ type: [String] }) @IsArray() fileUrls: string[];
}

@ApiTags('disputes')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('disputes')
export class DisputesController {
  constructor(private disputes: DisputesService) {}

  @ThrottleRelaxed()
  @Get()
  @ApiOperation({ summary: 'List my disputes (as reporter or against)' })
  listMine(
    @CurrentUser('id') userId: string,
    @Query('page') page = 1,
    @Query('limit') limit = 20,
  ) {
    return this.disputes.listMyDisputes(userId, +page, +limit);
  }

  @ThrottleStrict()
  @Post()
  @ApiOperation({ summary: 'Open a dispute on a service request' })
  open(@CurrentUser('id') userId: string, @Body() dto: OpenDisputeDto) {
    return this.disputes.openDispute(userId, dto.requestId, dto.reason, dto.details, dto.evidence);
  }

  @ThrottleRelaxed()
  @Get(':disputeId')
  @ApiOperation({ summary: 'Get dispute details' })
  getOne(@CurrentUser('id') userId: string, @Param('disputeId') disputeId: string) {
    return this.disputes.getDispute(userId, disputeId);
  }

  @ThrottleDefault()
  @Post(':disputeId/evidence')
  @ApiOperation({ summary: 'Add evidence files to an open dispute' })
  addEvidence(
    @CurrentUser('id') userId: string,
    @Param('disputeId') disputeId: string,
    @Body() dto: AddEvidenceDto,
  ) {
    return this.disputes.addEvidence(userId, disputeId, dto.fileUrls);
  }

  @ThrottleStrict()
  @Post(':disputeId/escalate')
  @ApiOperation({ summary: 'Escalate dispute to admin review' })
  escalate(@CurrentUser('id') userId: string, @Param('disputeId') disputeId: string) {
    return this.disputes.escalate(userId, disputeId);
  }
}
