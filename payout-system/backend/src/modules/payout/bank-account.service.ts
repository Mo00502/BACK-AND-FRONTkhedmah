import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import { AddBankAccountDto } from './dto/payout.dto';
import * as crypto from 'crypto';

@Injectable()
export class BankAccountService {
  private readonly logger = new Logger(BankAccountService.name);
  private readonly ALGORITHM = 'aes-256-cbc';
  private readonly IV_LENGTH = 16;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Add a new bank account for a provider.
   * IBAN is encrypted with AES-256-CBC before storage.
   */
  async addBankAccount(providerId: string, dto: AddBankAccountDto) {
    if (!this.validateIban(dto.iban)) {
      throw new BadRequestException('Invalid Saudi IBAN format');
    }

    const ibanEncrypted = this.encryptIban(dto.iban);
    const ibanLast4 = dto.iban.slice(-4);

    // If first account, make it default automatically
    const existingCount = await this.prisma.bankAccount.count({ where: { providerId } });
    const isDefault = existingCount === 0;

    const account = await this.prisma.bankAccount.create({
      data: {
        providerId,
        fullName: dto.fullName,
        bankName: dto.bankName,
        ibanEncrypted,
        ibanLast4,
        isDefault,
      },
    });

    this.logger.log(`Bank account added: provider=${providerId} last4=${ibanLast4}`);

    return this.maskAccount(account);
  }

  /**
   * Update an existing bank account.
   */
  async updateBankAccount(id: string, providerId: string, dto: Partial<AddBankAccountDto>) {
    const account = await this.prisma.bankAccount.findFirst({
      where: { id, providerId },
    });

    if (!account) {
      throw new NotFoundException('Bank account not found');
    }

    const updateData: any = {};

    if (dto.fullName) updateData.fullName = dto.fullName;
    if (dto.bankName) updateData.bankName = dto.bankName;

    if (dto.iban) {
      if (!this.validateIban(dto.iban)) {
        throw new BadRequestException('Invalid Saudi IBAN format');
      }
      updateData.ibanEncrypted = this.encryptIban(dto.iban);
      updateData.ibanLast4 = dto.iban.slice(-4);
      updateData.isVerified = false; // Re-verify on IBAN change
    }

    const updated = await this.prisma.bankAccount.update({
      where: { id },
      data: updateData,
    });

    return this.maskAccount(updated);
  }

  /**
   * Set a bank account as default (unsets others atomically).
   */
  async setDefault(id: string, providerId: string): Promise<void> {
    const account = await this.prisma.bankAccount.findFirst({
      where: { id, providerId },
    });

    if (!account) {
      throw new NotFoundException('Bank account not found');
    }

    await this.prisma.$transaction([
      this.prisma.bankAccount.updateMany({
        where: { providerId },
        data: { isDefault: false },
      }),
      this.prisma.bankAccount.update({
        where: { id },
        data: { isDefault: true },
      }),
    ]);

    this.logger.log(`Default bank account set: id=${id} provider=${providerId}`);
  }

  /**
   * List all bank accounts for a provider — IBAN masked, showing only last 4.
   */
  async list(providerId: string) {
    const accounts = await this.prisma.bankAccount.findMany({
      where: { providerId },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    });

    return accounts.map((a) => this.maskAccount(a));
  }

  /**
   * Get a specific account and decrypt IBAN for internal use (not exposed in API).
   */
  async getWithDecryptedIban(id: string, providerId: string): Promise<{ account: any; iban: string }> {
    const account = await this.prisma.bankAccount.findFirst({
      where: { id, providerId },
    });

    if (!account) {
      throw new NotFoundException('Bank account not found');
    }

    const iban = this.decryptIban(account.ibanEncrypted);
    return { account: this.maskAccount(account), iban };
  }

  /**
   * Validate Saudi IBAN: SA + exactly 22 digits (total 24 chars).
   */
  validateIban(iban: string): boolean {
    return /^SA[0-9]{22}$/.test(iban);
  }

  private encryptIban(iban: string): string {
    const key = this.getEncryptionKey();
    const iv = crypto.randomBytes(this.IV_LENGTH);
    const cipher = crypto.createCipheriv(this.ALGORITHM, key, iv);

    let encrypted = cipher.update(iban, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    // Store IV prepended to ciphertext (iv:ciphertext)
    return `${iv.toString('hex')}:${encrypted}`;
  }

  decryptIban(encrypted: string): string {
    const key = this.getEncryptionKey();
    const [ivHex, ciphertext] = encrypted.split(':');

    if (!ivHex || !ciphertext) {
      throw new Error('Invalid encrypted IBAN format');
    }

    const iv = Buffer.from(ivHex, 'hex');
    const decipher = crypto.createDecipheriv(this.ALGORITHM, key, iv);

    let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  }

  private getEncryptionKey(): Buffer {
    const keyHex = this.configService.get<string>('PAYOUT_ENCRYPTION_KEY');
    if (!keyHex || keyHex.length < 32) {
      throw new Error('PAYOUT_ENCRYPTION_KEY must be at least 32 characters');
    }
    // Use first 32 bytes
    return Buffer.from(keyHex.slice(0, 32), 'utf8');
  }

  private maskAccount(account: any) {
    const { ibanEncrypted, ...rest } = account;
    return {
      ...rest,
      ibanMasked: `SA********************${account.ibanLast4}`,
    };
  }
}
