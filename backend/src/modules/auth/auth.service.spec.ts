import { Test, TestingModule } from '@nestjs/testing';
import {
  ConflictException,
  UnauthorizedException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AuthService } from './auth.service';
import { PrismaService } from '../../prisma/prisma.service';
import * as bcrypt from 'bcryptjs';

// ── Helpers ───────────────────────────────────────────────────────────────────

const HASH = (v: string) => bcrypt.hashSync(v, 4); // fast rounds for tests

const makeUser = (overrides: any = {}) => ({
  id: 'user-1',
  email: 'test@example.com',
  username: 'test_user',
  passwordHash: HASH('Demo@12345'),
  emailVerified: true,
  emailVerifiedAt: new Date(),
  phone: null,
  role: 'CUSTOMER',
  status: 'ACTIVE',
  deletedAt: null,
  ...overrides,
});

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockPrisma = {
  user: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    findUniqueOrThrow: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  emailVerificationToken: {
    create: jest.fn(),
    findFirst: jest.fn(),
    update: jest.fn(),
  },
  passwordResetToken: {
    create: jest.fn(),
    findFirst: jest.fn(),
    update: jest.fn(),
  },
  refreshToken: {
    create: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    findUniqueOrThrow: jest.fn(),
  },
  $transaction: jest.fn((ops: any[]) => Promise.all(ops)),
};

const mockJwt = { sign: jest.fn().mockReturnValue('mock_access_token') };
const mockConfig = { get: jest.fn(), getOrThrow: jest.fn().mockReturnValue('secret') };
const mockEvents = { emit: jest.fn() };

// ── Test suite ────────────────────────────────────────────────────────────────

describe('AuthService', () => {
  let service: AuthService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: JwtService, useValue: mockJwt },
        { provide: ConfigService, useValue: mockConfig },
        { provide: EventEmitter2, useValue: mockEvents },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  // ── registerCustomer ───────────────────────────────────────────────────────

  describe('registerCustomer', () => {
    it('creates user and emits verification event', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      mockPrisma.user.create.mockResolvedValue(makeUser());
      mockPrisma.emailVerificationToken.create.mockResolvedValue({ id: 'tok-1' });

      const result = await service.registerCustomer({
        email: 'test@example.com',
        username: 'test_user',
        password: 'Demo@12345',
      });

      expect(result.message).toContain('verify');
      expect(mockEvents.emit).toHaveBeenCalledWith(
        'auth.email_verification_requested',
        expect.objectContaining({ email: 'test@example.com' }),
      );
    });

    it('throws ConflictException if email already exists', async () => {
      mockPrisma.user.findUnique
        .mockResolvedValueOnce(makeUser()) // email match
        .mockResolvedValueOnce(null); // username ok

      await expect(
        service.registerCustomer({
          email: 'test@example.com',
          username: 'new_user',
          password: 'Demo@12345',
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('throws ConflictException if username already taken', async () => {
      mockPrisma.user.findUnique
        .mockResolvedValueOnce(null) // email ok
        .mockResolvedValueOnce(makeUser()); // username match

      await expect(
        service.registerCustomer({
          email: 'new@example.com',
          username: 'test_user',
          password: 'Demo@12345',
        }),
      ).rejects.toThrow(ConflictException);
    });
  });

  // ── registerProvider ───────────────────────────────────────────────────────

  describe('registerProvider', () => {
    it('creates provider with PROVIDER role and emits verification', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      mockPrisma.user.create.mockResolvedValue(makeUser({ role: 'PROVIDER' }));
      mockPrisma.emailVerificationToken.create.mockResolvedValue({ id: 'tok-1' });

      const result = await service.registerProvider({
        email: 'pro@example.com',
        username: 'pro_user',
        password: 'Demo@12345',
      });

      expect(result.message).toContain('verify');
      expect(mockPrisma.user.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ role: 'PROVIDER' }) }),
      );
    });
  });

  // ── verifyEmail ────────────────────────────────────────────────────────────

  describe('verifyEmail', () => {
    it('verifies email when token is valid', async () => {
      const hex = 'a'.repeat(64);
      const hash = HASH(hex);
      mockPrisma.emailVerificationToken.findFirst.mockResolvedValue({
        id: 'tok-1',
        userId: 'user-1',
        tokenHash: hash,
      });
      mockPrisma.emailVerificationToken.update.mockResolvedValue({});
      mockPrisma.user.update.mockResolvedValue({});

      const result = await service.verifyEmail(`user-1:${hex}`);
      expect(result.message).toContain('verified');
      expect(mockEvents.emit).toHaveBeenCalledWith('auth.email_verified', { userId: 'user-1' });
    });

    it('throws BadRequestException for malformed token (no colon)', async () => {
      await expect(service.verifyEmail('badtoken')).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when token record not found', async () => {
      mockPrisma.emailVerificationToken.findFirst.mockResolvedValue(null);
      await expect(service.verifyEmail('user-1:' + 'a'.repeat(64))).rejects.toThrow(
        BadRequestException,
      );
    });

    it('throws BadRequestException for wrong hex (hash mismatch)', async () => {
      mockPrisma.emailVerificationToken.findFirst.mockResolvedValue({
        id: 'tok-1',
        userId: 'user-1',
        tokenHash: HASH('correct_hex'),
      });
      await expect(service.verifyEmail('user-1:wrong_hex')).rejects.toThrow(BadRequestException);
    });
  });

  // ── login ──────────────────────────────────────────────────────────────────

  describe('login', () => {
    beforeEach(() => {
      mockPrisma.refreshToken.create.mockResolvedValue({ id: 'rt-1' });
      mockPrisma.user.update.mockResolvedValue({});
    });

    it('returns token pair for valid email + password', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(makeUser());
      const result = await service.login({
        identifier: 'test@example.com',
        password: 'Demo@12345',
      });
      expect(result.accessToken).toBe('mock_access_token');
      expect(result.tokenId).toBe('rt-1');
    });

    it('allows login by username', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(makeUser());
      await expect(
        service.login({ identifier: 'test_user', password: 'Demo@12345' }),
      ).resolves.toMatchObject({ accessToken: 'mock_access_token' });
    });

    it('throws UnauthorizedException for unknown identifier', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(null);
      await expect(service.login({ identifier: 'nobody', password: 'x' })).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('throws UnauthorizedException for wrong password', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(makeUser());
      await expect(
        service.login({ identifier: 'test@example.com', password: 'WrongPass!' }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('throws ForbiddenException if email not verified', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(makeUser({ emailVerified: false }));
      await expect(
        service.login({ identifier: 'test@example.com', password: 'Demo@12345' }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('throws ForbiddenException for BANNED account', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(makeUser({ status: 'BANNED' }));
      await expect(
        service.login({ identifier: 'test@example.com', password: 'Demo@12345' }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('throws ForbiddenException for SUSPENDED account', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(makeUser({ status: 'SUSPENDED' }));
      await expect(
        service.login({ identifier: 'test@example.com', password: 'Demo@12345' }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('emits auth.login with IP on success', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(makeUser());
      await service.login({ identifier: 'test@example.com', password: 'Demo@12345' }, '10.0.0.1');
      expect(mockEvents.emit).toHaveBeenCalledWith('auth.login', {
        userId: 'user-1',
        ip: '10.0.0.1',
      });
    });
  });

  // ── forgotPassword ─────────────────────────────────────────────────────────

  describe('forgotPassword', () => {
    it('always returns same OK message regardless of email existence', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      const result = await service.forgotPassword({ email: 'nobody@example.com' });
      expect(result.message).toContain('registered');
      expect(mockEvents.emit).not.toHaveBeenCalled();
    });

    it('emits reset event for known verified user', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(makeUser());
      mockPrisma.passwordResetToken.create.mockResolvedValue({ id: 'rst-1' });

      await service.forgotPassword({ email: 'test@example.com' });
      expect(mockEvents.emit).toHaveBeenCalledWith(
        'auth.password_reset_requested',
        expect.objectContaining({ userId: 'user-1' }),
      );
    });

    it('silently skips unverified users (no email leak)', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(makeUser({ emailVerified: false }));
      const result = await service.forgotPassword({ email: 'test@example.com' });
      expect(result.message).toContain('registered');
      expect(mockEvents.emit).not.toHaveBeenCalled();
    });
  });

  // ── resetPassword ──────────────────────────────────────────────────────────

  describe('resetPassword', () => {
    it('updates password and revokes all refresh tokens', async () => {
      const hex = 'b'.repeat(64);
      const hash = HASH(hex);
      mockPrisma.passwordResetToken.findFirst.mockResolvedValue({
        id: 'rst-1',
        userId: 'user-1',
        tokenHash: hash,
      });
      mockPrisma.passwordResetToken.update.mockResolvedValue({});
      mockPrisma.user.update.mockResolvedValue({});
      mockPrisma.refreshToken.updateMany.mockResolvedValue({});

      const result = await service.resetPassword({
        token: `user-1:${hex}`,
        newPassword: 'NewPass@99',
      });
      expect(result.message).toContain('reset');
      expect(mockPrisma.refreshToken.updateMany).toHaveBeenCalled();
      expect(mockEvents.emit).toHaveBeenCalledWith('auth.password_reset', expect.any(Object));
    });

    it('throws BadRequestException for malformed token', async () => {
      await expect(
        service.resetPassword({ token: 'no_colon', newPassword: 'NewPass@99' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException for expired / already-used token', async () => {
      mockPrisma.passwordResetToken.findFirst.mockResolvedValue(null);
      await expect(
        service.resetPassword({ token: `user-1:${'b'.repeat(64)}`, newPassword: 'NewPass@99' }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ── refreshTokens ──────────────────────────────────────────────────────────

  describe('refreshTokens', () => {
    it('returns new token pair for valid refresh token', async () => {
      const raw = 'raw_refresh_value';
      const hash = HASH(raw);
      mockPrisma.refreshToken.findUnique.mockResolvedValue({
        id: 'rt-1',
        userId: 'user-1',
        tokenHash: hash,
        revokedAt: null,
        expiresAt: new Date(Date.now() + 86_400_000),
      });
      mockPrisma.refreshToken.update.mockResolvedValue({});
      mockPrisma.user.findUniqueOrThrow.mockResolvedValue(makeUser());
      mockPrisma.refreshToken.create.mockResolvedValue({ id: 'rt-2' });

      const result = await service.refreshTokens({ tokenId: 'rt-1', refreshToken: raw });
      expect(result.accessToken).toBe('mock_access_token');
      expect(result.tokenId).toBe('rt-2');
    });

    it('throws UnauthorizedException for revoked token', async () => {
      mockPrisma.refreshToken.findUnique.mockResolvedValue({
        id: 'rt-1',
        revokedAt: new Date(),
        expiresAt: new Date(Date.now() + 1000),
        tokenHash: 'x',
      });
      await expect(service.refreshTokens({ tokenId: 'rt-1', refreshToken: 'any' })).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('throws UnauthorizedException for expired token', async () => {
      mockPrisma.refreshToken.findUnique.mockResolvedValue({
        id: 'rt-1',
        revokedAt: null,
        expiresAt: new Date(Date.now() - 1000),
        tokenHash: 'x',
      });
      await expect(service.refreshTokens({ tokenId: 'rt-1', refreshToken: 'any' })).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  // ── logout ─────────────────────────────────────────────────────────────────

  describe('logout', () => {
    it('revokes specific token when tokenId provided', async () => {
      mockPrisma.refreshToken.updateMany.mockResolvedValue({ count: 1 });
      const result = await service.logout('user-1', 'rt-1');
      expect(result.message).toContain('out');
      expect(mockPrisma.refreshToken.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 'rt-1', userId: 'user-1' }),
        }),
      );
    });

    it('revokes ALL active tokens when no tokenId (sign-out everywhere)', async () => {
      mockPrisma.refreshToken.updateMany.mockResolvedValue({ count: 3 });
      await service.logout('user-1');
      expect(mockPrisma.refreshToken.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: 'user-1', revokedAt: null }),
        }),
      );
    });
  });
});
