import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength, MaxLength, Matches, IsOptional } from 'class-validator';

export class ResetPasswordDto {
  @ApiProperty({ description: 'Token received via email reset link' })
  @IsString()
  token: string;

  @ApiProperty({ example: 'NewSecurePass123!', minLength: 8 })
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/, {
    message: 'Password must contain uppercase, lowercase, and a digit',
  })
  newPassword: string;

  // Set by the controller from request.ip
  @IsOptional()
  @IsString()
  ip?: string;
}
