import { IsString, IsOptional, IsDateString, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateRequestDto {
  @ApiProperty({ example: 'plumber' })
  @IsString()
  serviceId: string;

  @ApiProperty({ example: 'الرياض' })
  @IsString()
  city: string;

  @ApiProperty({ example: 'أحتاج إصلاح تسريب في الحمام' })
  @IsString()
  @MaxLength(2000)
  description: string;

  @ApiPropertyOptional({ enum: ['indoor', 'outdoor'] })
  @IsOptional()
  @IsString()
  indoorOutdoor?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  size?: string;

  @ApiPropertyOptional({ enum: ['low', 'normal', 'urgent'] })
  @IsOptional()
  @IsString()
  urgency?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  scheduledAt?: string;
}
