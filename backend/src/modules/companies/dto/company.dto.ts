import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { IsString, IsOptional, MaxLength, IsUrl, Matches } from 'class-validator';

export class CreateCompanyDto {
  @ApiProperty({ example: 'مجموعة البناء المتكامل' })
  @IsString()
  @MaxLength(120)
  name: string;

  @ApiPropertyOptional({ example: 'Integrated Construction Group' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  nameEn?: string;

  @ApiProperty({
    example: '1000000001',
    description: '10-digit Saudi commercial registration number',
  })
  @IsString()
  @Matches(/^\d{10}$/, { message: 'CR number must be exactly 10 digits' })
  crNumber: string;

  @ApiPropertyOptional({ example: 'الرياض' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  city?: string;

  @ApiPropertyOptional({ example: 'https://example.com/logo.png' })
  @IsOptional()
  @IsUrl()
  logoUrl?: string;

  @ApiPropertyOptional({ example: 'شركة متخصصة في المقاولات والتطوير العقاري' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({ example: '+96611234567' })
  @IsOptional()
  @IsString()
  phone?: string;

  @ApiPropertyOptional({ example: 'info@company.com' })
  @IsOptional()
  @IsString()
  email?: string;

  @ApiPropertyOptional({ example: 'https://company.com' })
  @IsOptional()
  @IsUrl()
  website?: string;
}

export class UpdateCompanyDto extends PartialType(CreateCompanyDto) {}
