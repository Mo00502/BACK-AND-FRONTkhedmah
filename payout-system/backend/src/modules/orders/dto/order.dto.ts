import {
  IsString,
  IsNumber,
  IsOptional,
  IsBoolean,
  IsDateString,
  Min,
  Max,
  MinLength,
  MaxLength,
  IsEnum,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { OrderStatus } from '@prisma/client';

export class CreateOrderDto {
  @ApiProperty({ example: 'تركيب مكيف سبليت' })
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  serviceTitle: string;

  @ApiPropertyOptional({ example: 'تركيب وحدة داخلية وخارجية مقاس 18000 وحدة حرارية' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiProperty({ example: 500.0 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(1)
  @Max(1000000)
  totalAmount: number;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  hasMaterials?: boolean;

  @ApiPropertyOptional({ example: 150.0 })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  materialsAmount?: number;

  @ApiPropertyOptional({ example: 'الرياض، حي النزهة، شارع التحلية' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  address?: string;

  @ApiPropertyOptional({ example: '2025-06-01T10:00:00Z' })
  @IsOptional()
  @IsDateString()
  scheduledAt?: string;
}

export class UpdateOrderStatusDto {
  @ApiProperty({ enum: OrderStatus })
  @IsEnum(OrderStatus)
  status: OrderStatus;
}
