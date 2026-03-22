import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString } from 'class-validator';

export class ForgotPasswordDto {
  @ApiProperty({ example: 'sara@example.com' })
  @IsEmail()
  email: string;

  // Set by the controller from request.ip — not exposed in the API body
  @IsOptional()
  @IsString()
  ip?: string;
}
