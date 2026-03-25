import {
  IsString,
  IsNotEmpty,
  MinLength,
  MaxLength,
  Matches,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class AddBankAccountDto {
  @ApiProperty({ example: 'خالد عبدالله العمري' })
  @IsString()
  @IsNotEmpty()
  @MinLength(3)
  @MaxLength(100)
  fullName: string;

  @ApiProperty({ example: 'بنك الراجحي' })
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(100)
  bankName: string;

  @ApiProperty({ example: 'SA4420000001234567891234' })
  @IsString()
  @IsNotEmpty()
  @Matches(/^SA[0-9]{22}$/, {
    message: 'IBAN must be in Saudi format: SA followed by 22 digits (total 24 chars)',
  })
  iban: string;
}

export class RequestPayoutDto {
  @ApiProperty({ example: 'escrow-uuid-here', description: 'Escrow ID to request payout for' })
  @IsString()
  @IsNotEmpty()
  escrowId: string;
}
