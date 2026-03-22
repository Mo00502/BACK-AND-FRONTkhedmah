import { IsInt, Min, Max, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class RateConsultationDto {
  @ApiProperty({ example: 5, description: 'Rating 1–5' })
  @IsInt()
  @Min(1)
  @Max(5)
  rating: number;

  @ApiPropertyOptional({ example: 'خبرة عالية وشرح واضح' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}
