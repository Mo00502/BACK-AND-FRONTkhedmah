import { IsString, IsOptional, IsNumber, IsBoolean, IsArray, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateEquipmentDto {
  @ApiPropertyOptional() @IsOptional() @IsString() name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() description?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() category?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() brand?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() model?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber() year?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() capacity?: string;
  @ApiPropertyOptional() @IsOptional() @IsArray() imageUrls?: string[];
  @ApiPropertyOptional() @IsOptional() @IsString() emoji?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() region?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() city?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) hourPrice?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) dayPrice?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) weekPrice?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) monthPrice?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() hasOperator?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() hasDelivery?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) deliveryCost?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) deposit?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() minRental?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isAvailable?: boolean;
}
