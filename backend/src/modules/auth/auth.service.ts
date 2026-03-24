import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  ConflictException,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../prisma/prisma.service';
import * as bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { JwtPayload } from './strategies/jwt.strategy';
import { RegisterCustomerDto } from './dto/register-customer.dto';
import { RegisterProviderDto } from './dto/register-provider.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';

const BCRYPT_ROUNDS = 12;
const EMAIL_TOKEN_BYTES = 32; // 256-bit raw token → 64-char hex
const VERIFY_TOKEN_TTL_HOURS = 24;
const RESET_TOKEN_TTL_MINUTES = 60;

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private config: ConfigService,
    private events: EventEmitter2,
  ) {}

  // ── Customer Registration ────────────────────────────────────────────────────

  async registerCustomer(dto: RegisterCustomerDto) {
    await this.assertEmailAndUsernameAvailable(dto.email, dto.username);

    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);

    const user = await this.prisma.user.create({
      data: {
        email: dto.email.toLowerCase(),
        username: dto.username.toLowerCase(),
        passwordHash,
        role: 'CUSTOMER',
        status: 'PENDING_VERIFICATION',
        profile: {
          create: {
            nameAr: dto.nameAr ?? null,
            nameEn: dto.nameEn ?? null,
          },
        },
      },
    });

    const { rawToken, tokenHash, expiresAt } = await this.createEmailVerificationToken(user.id);
    this.events.emit('auth.email_verification_requested', {
      userId: user.id,
      email: user.email,
      token: rawToken,
      tokenId: tokenHash,
      expiresAt,
    });

    return {
      message: 'Registration successful. Please check your email to verify your account.',
      userId: user.id,
    };
  }

  // ── Provider Registration ────────────────────────────────────────────────────

  async registerProvider(dto: RegisterProviderDto) {
    await this.assertEmailAndUsernameAvailable(dto.email, dto.username);

    // phone uniqueness check (optional but provided for providers)
    if (dto.phone) {
      const phoneExists = await this.prisma.user.findUnique({ where: { phone: dto.phone } });
      if (phoneExists) throw new ConflictException('Phone number already registered');
    }

    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);

    const user = await this.prisma.user.create({
      data: {
        email: dto.email.toLowerCase(),
        username: dto.username.toLowerCase(),
        passwordHash,
        phone: dto.phone ?? null,
        role: 'PROVIDER',
        status: 'PENDING_VERIFICATION',
        profile: {
          create: {
            nameAr: dto.nameAr ?? null,
            nameEn: dto.nameEn ?? null,
          },
        },
        providerProfile: {
          create: {
            verificationStatus: 'PENDING_SUBMISSION',
          },
        },
      },
    });

    const { rawToken, expiresAt } = await this.createEmailVerificationToken(user.id);
    this.events.emit('auth.email_verification_requested', {
      userId: user.id,
      email: user.email,
      token: rawToken,
      expiresAt,
    });

    return {
      message:
        'Provider registration successful. Please verify your email, then submit your documents for review.',
      userId: user.id,
    };
  }

  // ── Email Verification ───────────────────────────────────────────────────────

  async verifyEmail(rawToken: string) {
    // Token is `userId:hex` — split to avoid full-table scan
    const [userId, hex] = rawToken.split(':');
    if (!userId || !hex) throw new BadRequestException('Invalid verification link');

    const record = await this.prisma.emailVerificationToken.findFirst({
      where: { userId, usedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });

    if (!record) throw new BadRequestException('Verification link expired or already used');

    const valid = await bcrypt.compare(hex, record.tokenHash);
    if (!valid) throw new BadRequestException('Invalid verification link');

    // Mark used + activate user in one transaction
    await this.prisma.$transaction([
      this.prisma.emailVerificationToken.update({
        where: { id: record.id },
        data: { usedAt: new Date() },
      }),
      this.prisma.user.update({
        where: { id: userId },
        data: {
          emailVerified: true,
          emailVerifiedAt: new Date(),
          status: 'ACTIVE',
        },
      }),
    ]);

    this.events.emit('auth.email_verified', { userId });
    return { message: 'Email verified successfully. You can now log in.' };
  }

  async resendVerificationEmail(email: string) {
    const user = await this.prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    // Always respond OK — never expose whether email exists
    if (!user || user.emailVerified)
      return { message: 'If that email exists and is unverified, a link has been sent.' };

    const { rawToken, expiresAt } = await this.createEmailVerificationToken(user.id);
    this.events.emit('auth.email_verification_requested', {
      userId: user.id,
      email: user.email,
      token: rawToken,
      expiresAt,
    });

    return { message: 'If that email exists and is unverified, a link has been sent.' };
  }

  // ── Login ────────────────────────────────────────────────────────────────────

  async login(dto: LoginDto, ip?: string) {
    // Allow login with email OR username
    const identifier = dto.identifier.toLowerCase();
    const user = await this.prisma.user.findFirst({
      where: {
        OR: [{ email: identifier }, { username: identifier }],
        deletedAt: null,
      },
    });

    if (!user) throw new UnauthorizedException('Invalid credentials');

    const validPassword = await bcrypt.compare(dto.password, user.passwordHash);
    if (!validPassword) throw new UnauthorizedException('Invalid credentials');

    if (!user.emailVerified) {
      throw new ForbiddenException('Please verify your email before logging in');
    }

    if (user.status === 'BANNED') {
      throw new ForbiddenException('This account has been banned');
    }

    if (user.status === 'SUSPENDED' || user.suspended) {
      throw new ForbiddenException('This account is suspended');
    }

    // Update last login metadata
    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date(), lastLoginIp: ip ?? null },
    });

    this.events.emit('auth.login', { userId: user.id, ip });

    return this.generateTokenPair(user);
  }

  // ── Forgot Password ──────────────────────────────────────────────────────────

  async forgotPassword(dto: ForgotPasswordDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email.toLowerCase(), deletedAt: null },
    });

    // Always return OK — don't leak whether email exists
    if (!user || !user.emailVerified) {
      return { message: 'If that email is registered, a reset link has been sent.' };
    }

    const { rawToken, expiresAt } = await this.createPasswordResetToken(user.id, dto.ip);
    this.events.emit('auth.password_reset_requested', {
      userId: user.id,
      email: user.email,
      token: rawToken,
      expiresAt,
      ip: dto.ip,
    });

    return { message: 'If that email is registered, a reset link has been sent.' };
  }

  // ── Reset Password ───────────────────────────────────────────────────────────

  async resetPassword(dto: ResetPasswordDto) {
    const [userId, hex] = dto.token.split(':');
    if (!userId || !hex) throw new BadRequestException('Invalid reset link');

    const record = await this.prisma.passwordResetToken.findFirst({
      where: { userId, usedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });

    if (!record) throw new BadRequestException('Reset link expired or already used');

    const valid = await bcrypt.compare(hex, record.tokenHash);
    if (!valid) throw new BadRequestException('Invalid reset link');

    const passwordHash = await bcrypt.hash(dto.newPassword, BCRYPT_ROUNDS);

    await this.prisma.$transaction([
      this.prisma.passwordResetToken.update({
        where: { id: record.id },
        data: { usedAt: new Date() },
      }),
      this.prisma.user.update({
        where: { id: userId },
        data: { passwordHash },
      }),
      // Invalidate all active refresh tokens — force re-login everywhere
      this.prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);

    this.events.emit('auth.password_reset', { userId, ip: dto.ip });
    return { message: 'Password reset successfully. Please log in with your new password.' };
  }

  // ── Token Refresh ────────────────────────────────────────────────────────────

  async refreshTokens(dto: RefreshTokenDto) {
    const stored = await this.prisma.refreshToken.findUnique({ where: { id: dto.tokenId } });

    if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
      throw new UnauthorizedException('Refresh token invalid or expired');
    }

    const valid = await bcrypt.compare(dto.refreshToken, stored.tokenHash);
    if (!valid) throw new UnauthorizedException('Invalid refresh token');

    await this.prisma.refreshToken.update({
      where: { id: dto.tokenId },
      data: { revokedAt: new Date() },
    });

    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: stored.userId } });

    if (user.deletedAt) throw new UnauthorizedException('Account not found');
    if (user.status === 'BANNED') throw new ForbiddenException('This account has been banned');
    if (user.status === 'SUSPENDED' || user.suspended) throw new ForbiddenException('This account is suspended');

    return this.generateTokenPair(user);
  }

  // ── Me ───────────────────────────────────────────────────────────────────────

  async getMe(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId, deletedAt: null },
      select: {
        id: true,
        email: true,
        username: true,
        phone: true,
        role: true,
        status: true,
        emailVerified: true,
        emailVerifiedAt: true,
        lastLoginAt: true,
        createdAt: true,
        profile: {
          select: {
            nameAr: true,
            nameEn: true,
            city: true,
            avatarUrl: true,
            bio: true,
            gender: true,
            langPref: true,
          },
        },
        providerProfile: {
          select: {
            verificationStatus: true,
            verified: true,
            ratingAvg: true,
            completedJobs: true,
            docsSubmittedAt: true,
            approvedAt: true,
            rejectionReason: true,
          },
        },
      },
    });
    return user;
  }

  // ── Change Password (authenticated) ────────────────────────────────────────

  async changePassword(userId: string, currentPassword: string, newPassword: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });

    const valid = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!valid) throw new UnauthorizedException('Current password is incorrect');

    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: userId }, data: { passwordHash } }),
      // Revoke all other refresh tokens — keep current session alive only if caller manages it
      this.prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);

    this.events.emit('auth.password_changed', { userId });
    return { message: 'Password changed successfully. Please log in again.' };
  }

  // ── Logout ───────────────────────────────────────────────────────────────────

  async logout(userId: string, tokenId?: string) {
    if (tokenId) {
      await this.prisma.refreshToken.updateMany({
        where: { id: tokenId, userId },
        data: { revokedAt: new Date() },
      });
    } else {
      await this.prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
    return { message: 'Logged out successfully' };
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  private async assertEmailAndUsernameAvailable(email: string, username: string) {
    const [emailExists, usernameExists] = await Promise.all([
      this.prisma.user.findUnique({ where: { email: email.toLowerCase() } }),
      this.prisma.user.findUnique({ where: { username: username.toLowerCase() } }),
    ]);
    if (emailExists) throw new ConflictException('Email already registered');
    if (usernameExists) throw new ConflictException('Username already taken');
  }

  private async createEmailVerificationToken(userId: string) {
    const hex = randomBytes(EMAIL_TOKEN_BYTES).toString('hex');
    const rawToken = `${userId}:${hex}`; // userId prefix avoids full-table scan
    const tokenHash = await bcrypt.hash(hex, BCRYPT_ROUNDS);
    const expiresAt = new Date(Date.now() + VERIFY_TOKEN_TTL_HOURS * 3_600_000);

    await this.prisma.emailVerificationToken.create({
      data: { userId, tokenHash, expiresAt },
    });

    return { rawToken, tokenHash, expiresAt };
  }

  private async createPasswordResetToken(userId: string, ip?: string) {
    const hex = randomBytes(EMAIL_TOKEN_BYTES).toString('hex');
    const rawToken = `${userId}:${hex}`;
    const tokenHash = await bcrypt.hash(hex, BCRYPT_ROUNDS);
    const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MINUTES * 60_000);

    await this.prisma.passwordResetToken.create({
      data: { userId, tokenHash, expiresAt, ipAddress: ip ?? null },
    });

    return { rawToken, expiresAt };
  }

  private async generateTokenPair(user: {
    id: string;
    email: string;
    username: string;
    role: string;
  }) {
    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      username: user.username,
      role: user.role,
    };

    const accessToken = this.jwt.sign(payload, {
      secret: this.config.getOrThrow('JWT_SECRET'),
      expiresIn: this.config.get('JWT_EXPIRES_IN', '15m'),
    });

    const rawRefresh = uuidv4();
    const tokenHash = await bcrypt.hash(rawRefresh, BCRYPT_ROUNDS);
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60_000);

    const stored = await this.prisma.refreshToken.create({
      data: { userId: user.id, tokenHash, expiresAt },
    });

    return {
      accessToken,
      tokenId: stored.id,
      refreshToken: rawRefresh,
      expiresIn: 900,
    };
  }
}
