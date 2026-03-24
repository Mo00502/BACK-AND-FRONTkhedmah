import {
  IsString,
  IsNumber,
  IsOptional,
  IsEnum,
  IsDateString,
  Min,
  Max,
  IsPositive,
  IsBoolean,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TenderStatus, TenderBidStatus } from '@prisma/client';

export class CreateTenderDto {
  @ApiProperty() @IsString() title: string;
  @ApiProperty() @IsString() category: string;
  @ApiPropertyOptional() @IsString() @IsOptional() description?: string;
  @ApiPropertyOptional() @IsString() @IsOptional() scope?: string;
  @ApiProperty() @IsString() region: string;
  @ApiPropertyOptional() @IsNumber() @IsPositive() @IsOptional() budgetMin?: number;
  @ApiPropertyOptional() @IsNumber() @IsPositive() @IsOptional() budgetMax?: number;
  @ApiPropertyOptional() @IsString() @IsOptional() budgetMode?: string;
  @ApiProperty() @IsDateString() deadline: string;
  @ApiPropertyOptional() @IsDateString() @IsOptional() startDate?: string;
  @ApiPropertyOptional() @IsString() @IsOptional() qualifications?: string;
}

export class SubmitBidDto {
  @ApiProperty() @IsNumber() @IsPositive() amount: number;
  @ApiPropertyOptional() @IsNumber() @Min(1) @Max(120) @IsOptional() durationMonths?: number;
  @ApiPropertyOptional() @IsString() @IsOptional() note?: string;
  @ApiPropertyOptional() @IsBoolean() @IsOptional() termsAccepted?: boolean;
}

export class UpdateBidDto {
  @ApiPropertyOptional() @IsNumber() @IsPositive() @IsOptional() amount?: number;
  @ApiPropertyOptional() @IsNumber() @Min(1) @Max(120) @IsOptional() durationMonths?: number;
  @ApiPropertyOptional() @IsString() @IsOptional() note?: string;
}

export class CreateRequirementDto {
  @ApiProperty() @IsString() nameAr: string;
  @ApiProperty() @IsString() type: string;
  @ApiPropertyOptional() @IsNumber() @IsPositive() @IsOptional() quantity?: number;
  @ApiPropertyOptional() @IsNumber() @IsPositive() @IsOptional() durationDays?: number;
  @ApiPropertyOptional() @IsString() @IsOptional() sourceText?: string;
}

export class SubmitOfferDto {
  @ApiProperty() @IsNumber() @IsPositive() priceTotal: number;
  @ApiPropertyOptional() @IsNumber() @IsPositive() @IsOptional() pricePerUnit?: number;
  @ApiPropertyOptional() @IsString() @IsOptional() note?: string;
  @ApiPropertyOptional() @IsNumber() @Min(1) @IsOptional() deliveryDays?: number;
}
