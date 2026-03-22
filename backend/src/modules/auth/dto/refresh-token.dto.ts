import { IsString, IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RefreshTokenDto {
  @ApiProperty()
  @IsString()
  @IsUUID()
  tokenId: string;

  @ApiProperty()
  @IsString()
  refreshToken: string;
}
