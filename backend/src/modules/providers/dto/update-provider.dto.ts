import { IsOptional, IsString, IsInt, IsArray, Min, Max, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';

export class UpdateProviderDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(50)
  yearsExperience?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  crNumber?: string;

  @ApiPropertyOptional({ description: 'IBAN number (SA format)' })
  @IsOptional()
  @IsString()
  @MaxLength(34)
  ibanNumber?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  bankName?: string;
}

export class AddSkillDto {
  @ApiPropertyOptional()
  @IsString()
  serviceId: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  hourlyRate?: number;
}

export class SetAvailabilityDto {
  @ApiPropertyOptional({ type: [Object] })
  @IsArray()
  slots: { dayOfWeek: number; startTime: string; endTime: string }[];
}
