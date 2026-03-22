import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength, MaxLength } from 'class-validator';

export class LoginDto {
  @ApiProperty({
    example: 'sara@example.com',
    description: 'Email address OR username',
  })
  @IsString()
  @MaxLength(100)
  identifier: string;

  @ApiProperty({ example: 'SecurePass123!' })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  password: string;
}
