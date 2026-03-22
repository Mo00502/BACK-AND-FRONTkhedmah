import { IsString, IsOptional, IsNumber, IsDateString, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateTenderDto {
  @ApiProperty() @IsString() title: string;
  @ApiProperty() @IsString() category: string;
  @ApiProperty() @IsString() region: string;
  @ApiProperty() @IsDateString() deadline: string;

  @ApiPropertyOptional() @IsOptional() @IsString() description?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() scope?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) budgetMin?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) budgetMax?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() budgetMode?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() startDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() qualifications?: string;
}
