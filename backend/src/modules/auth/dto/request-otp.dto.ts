import { IsString, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RequestOtpDto {
  @ApiProperty({ example: '+966512345678', description: 'Saudi phone in E.164 format' })
  @IsString()
  @Matches(/^\+9665\d{8}$/, { message: 'Phone must be a valid Saudi number (+9665XXXXXXXX)' })
  phone: string;
}
