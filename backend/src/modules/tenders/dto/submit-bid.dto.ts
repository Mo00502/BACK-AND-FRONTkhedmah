import { IsNumber, IsBoolean, IsOptional, IsString, IsInt, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SubmitBidDto {
  @ApiProperty() @IsNumber() @Min(1) amount: number;
  @ApiProperty() @IsBoolean() termsAccepted: boolean;

  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) durationMonths?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() note?: string;
}
