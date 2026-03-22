import { IsString, IsOptional, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class AiRecommendDto {
  @ApiProperty({ example: 'أحتاج سباك لإصلاح تسريب في الحمام' })
  @IsString()
  @MaxLength(500)
  query: string;

  @ApiPropertyOptional({ example: 'الرياض' })
  @IsOptional()
  @IsString()
  city?: string;
}

export class AiQuoteEstimateDto {
  @ApiProperty({ example: 'سباكة' })
  @IsString()
  serviceCategory: string;

  @ApiProperty({ example: 'إصلاح تسريب أنابيب في الحمام، مساحة صغيرة' })
  @IsString()
  @MaxLength(1000)
  description: string;

  @ApiPropertyOptional({ example: 'urgent' })
  @IsOptional()
  @IsString()
  urgency?: string;

  @ApiPropertyOptional({ example: 'الرياض' })
  @IsOptional()
  @IsString()
  city?: string;
}

export class AiFaqDto {
  @ApiProperty({ example: 'كيف يمكنني الاعتراض على خدمة؟' })
  @IsString()
  @MaxLength(500)
  question: string;
}

export class AiCategorizeDto {
  @ApiProperty({ example: 'أحتاج شخص لتركيب مكيف جديد في غرفة النوم' })
  @IsString()
  @MaxLength(1000)
  description: string;
}
