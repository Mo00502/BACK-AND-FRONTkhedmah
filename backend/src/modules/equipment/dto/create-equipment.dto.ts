import { IsString, IsOptional, IsNumber, IsBoolean, IsArray, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateEquipmentDto {
  @ApiProperty() @IsString() name: string;
  @ApiProperty() @IsString() category: string;
  @ApiProperty() @IsString() region: string;

  @ApiPropertyOptional() @IsOptional() @IsString() brand?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber() year?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() hoursUsed?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() description?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() capacity?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() hasOperator?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() hasDelivery?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() hasInsurance?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) dayPrice?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) hourPrice?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) weekPrice?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) monthPrice?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) deposit?: number;
  @ApiPropertyOptional() @IsOptional() @IsArray() availableDays?: string[];
  @ApiPropertyOptional() @IsOptional() @IsString() minRental?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber() noticeHours?: number;
}
