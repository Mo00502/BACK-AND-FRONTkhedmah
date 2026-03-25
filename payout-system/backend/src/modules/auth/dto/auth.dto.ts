import {
  IsEmail,
  IsString,
  MinLength,
  MaxLength,
  IsOptional,
  IsEnum,
  Matches,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';

export class RegisterDto {
  @ApiProperty({ example: 'customer@example.com' })
  @IsEmail({}, { message: 'Invalid email address' })
  email: string;

  @ApiProperty({ example: 'SecurePass123!' })
  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters' })
  @MaxLength(72, { message: 'Password must not exceed 72 characters' })
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/, {
    message: 'Password must contain uppercase, lowercase and a number',
  })
  password: string;

  @ApiProperty({ example: 'محمد' })
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  firstName: string;

  @ApiProperty({ example: 'العمري' })
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  lastName: string;

  @ApiPropertyOptional({ example: '+966501234567' })
  @IsOptional()
  @IsString()
  @Matches(/^\+966[0-9]{9}$/, { message: 'Phone must be a valid Saudi number: +966XXXXXXXXX' })
  phone?: string;

  @ApiPropertyOptional({ enum: UserRole, default: UserRole.CUSTOMER })
  @IsOptional()
  @IsEnum(UserRole)
  role?: UserRole;
}

export class LoginDto {
  @ApiProperty({ example: 'customer@example.com' })
  @IsEmail({}, { message: 'Invalid email address' })
  email: string;

  @ApiProperty({ example: 'SecurePass123!' })
  @IsString()
  @MinLength(1)
  password: string;
}

export class RefreshTokenDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  refreshToken: string;
}
