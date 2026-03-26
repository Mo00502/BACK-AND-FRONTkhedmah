import {
  IsString,
  IsOptional,
  IsInt,
  IsNumber,
  IsDateString,
  IsEnum,
  MaxLength,
  Min,
  Max,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ConsultationMode } from '@prisma/client';

export class CreateConsultationDto {
  @ApiProperty({ example: 'consultant-electrical' })
  @IsString()
  serviceId: string;

  @ApiProperty({ example: 'استشارة في تصميم الشبكة الكهربائية' })
  @IsString()
  @MaxLength(200)
  topic: string;

  @ApiPropertyOptional({ example: 'أحتاج مراجعة مخططات التوزيع الكهربائي لمشروع تجاري' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional({ enum: ConsultationMode, default: ConsultationMode.CHAT })
  @IsOptional()
  @IsEnum(ConsultationMode)
  mode?: ConsultationMode;

  @ApiPropertyOptional({ example: 60, description: 'Duration in minutes' })
  @IsOptional()
  @IsInt()
  @Min(15)
  @Max(480)
  durationMinutes?: number;

  @ApiPropertyOptional({ example: '2026-03-25T10:00:00Z' })
  @IsOptional()
  @IsDateString()
  scheduledAt?: string;

  @ApiPropertyOptional({ example: 150, description: 'Provider hourly rate in SAR (min 50, max 10000)' })
  @IsOptional()
  @IsNumber()
  @Min(50, { message: 'السعر لا يقل عن 50 ريال في الساعة' })
  @Max(10000, { message: 'السعر لا يتجاوز 10,000 ريال في الساعة' })
  pricePerHour?: number;
}
