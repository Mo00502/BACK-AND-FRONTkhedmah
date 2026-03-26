import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';

// ── Mock service — every method called by the controller ─────────────────────

const mockService = {
  registerCustomer: jest.fn(),
  registerProvider: jest.fn(),
  verifyEmail: jest.fn(),
  resendVerificationEmail: jest.fn(),
  login: jest.fn(),
  forgotPassword: jest.fn(),
  resetPassword: jest.fn(),
  refreshTokens: jest.fn(),
  getMe: jest.fn(),
  changePassword: jest.fn(),
  logout: jest.fn(),
};

// Mock guards — always allow (guard logic is tested separately)
const mockJwtGuard = { canActivate: jest.fn().mockReturnValue(true) };
const mockRolesGuard = { canActivate: jest.fn().mockReturnValue(true) };

// ── Valid payloads ────────────────────────────────────────────────────────────

const VALID_CUSTOMER = {
  email: 'sara@example.com',
  username: 'sara_kh',
  password: 'SecurePass123!',
};

const VALID_PROVIDER = {
  email: 'ahmed@example.com',
  username: 'ahmed_pro',
  password: 'SecurePass123!',
};

const VALID_LOGIN = {
  identifier: 'sara@example.com',
  password: 'SecurePass123!',
};

const VALID_REFRESH = {
  tokenId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  refreshToken: 'some-refresh-token-string',
};

const TOKEN_PAIR = {
  accessToken: 'jwt-access-token',
  tokenId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  refreshToken: 'raw-refresh-token',
  expiresIn: 900,
};

// ─────────────────────────────────────────────────────────────────────────────

describe('AuthController (HTTP)', () => {
  let app: INestApplication;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [{ provide: AuthService, useValue: mockService }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(mockJwtGuard)
      .overrideGuard(RolesGuard)
      .useValue(mockRolesGuard)
      .compile();

    app = module.createNestApplication();

    // Inject a fake user so @CurrentUser() param decorator works without JWT
    app.use((req: any, _res: any, next: any) => {
      req.user = { id: 'user-test-id', role: 'CUSTOMER' };
      next();
    });

    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));
    await app.init();
  });

  afterEach(() => app.close());

  // ── POST /auth/register/customer ────────────────────────────────────────────

  describe('POST /auth/register/customer', () => {
    it('201 — happy path returns userId and message', async () => {
      mockService.registerCustomer.mockResolvedValue({
        message: 'Registration successful. Please check your email to verify your account.',
        userId: 'user-abc',
      });

      await request(app.getHttpServer())
        .post('/auth/register/customer')
        .send(VALID_CUSTOMER)
        .expect(201)
        .expect((res) => {
          expect(res.body.userId).toBe('user-abc');
          expect(res.body.message).toBeDefined();
        });

      expect(mockService.registerCustomer).toHaveBeenCalledWith(
        expect.objectContaining({ email: VALID_CUSTOMER.email }),
      );
    });

    it('400 — missing email fails validation', async () => {
      const { email: _email, ...body } = VALID_CUSTOMER;
      await request(app.getHttpServer())
        .post('/auth/register/customer')
        .send(body)
        .expect(400);

      expect(mockService.registerCustomer).not.toHaveBeenCalled();
    });

    it('400 — invalid email format fails validation', async () => {
      await request(app.getHttpServer())
        .post('/auth/register/customer')
        .send({ ...VALID_CUSTOMER, email: 'not-an-email' })
        .expect(400);
    });

    it('400 — missing username fails validation', async () => {
      const { username: _username, ...body } = VALID_CUSTOMER;
      await request(app.getHttpServer())
        .post('/auth/register/customer')
        .send(body)
        .expect(400);
    });

    it('400 — password shorter than 8 chars fails validation', async () => {
      await request(app.getHttpServer())
        .post('/auth/register/customer')
        .send({ ...VALID_CUSTOMER, password: 'Ab1' })
        .expect(400);
    });

    it('400 — weak password (no uppercase) fails validation', async () => {
      await request(app.getHttpServer())
        .post('/auth/register/customer')
        .send({ ...VALID_CUSTOMER, password: 'alllower1!' })
        .expect(400);
    });

    it('400 — weak password (no digit) fails validation', async () => {
      await request(app.getHttpServer())
        .post('/auth/register/customer')
        .send({ ...VALID_CUSTOMER, password: 'NoDigitHere!' })
        .expect(400);
    });

    it('400 — username too short (< 3) fails validation', async () => {
      await request(app.getHttpServer())
        .post('/auth/register/customer')
        .send({ ...VALID_CUSTOMER, username: 'ab' })
        .expect(400);
    });

    it('400 — username with special chars fails validation', async () => {
      await request(app.getHttpServer())
        .post('/auth/register/customer')
        .send({ ...VALID_CUSTOMER, username: 'user@name!' })
        .expect(400);
    });
  });

  // ── POST /auth/register/provider ────────────────────────────────────────────

  describe('POST /auth/register/provider', () => {
    it('201 — happy path', async () => {
      mockService.registerProvider.mockResolvedValue({
        message:
          'Provider registration successful. Please verify your email, then submit your documents for review.',
        userId: 'provider-xyz',
      });

      await request(app.getHttpServer())
        .post('/auth/register/provider')
        .send(VALID_PROVIDER)
        .expect(201)
        .expect((res) => {
          expect(res.body.userId).toBe('provider-xyz');
        });
    });

    it('400 — missing email fails validation', async () => {
      const { email: _email, ...body } = VALID_PROVIDER;
      await request(app.getHttpServer())
        .post('/auth/register/provider')
        .send(body)
        .expect(400);
    });

    it('400 — missing username fails validation', async () => {
      const { username: _username, ...body } = VALID_PROVIDER;
      await request(app.getHttpServer())
        .post('/auth/register/provider')
        .send(body)
        .expect(400);
    });

    it('400 — missing password fails validation', async () => {
      const { password: _password, ...body } = VALID_PROVIDER;
      await request(app.getHttpServer())
        .post('/auth/register/provider')
        .send(body)
        .expect(400);
    });

    it('400 — weak password fails validation', async () => {
      await request(app.getHttpServer())
        .post('/auth/register/provider')
        .send({ ...VALID_PROVIDER, password: 'weakpass' })
        .expect(400);
    });

    it('400 — invalid phone format fails validation', async () => {
      await request(app.getHttpServer())
        .post('/auth/register/provider')
        .send({ ...VALID_PROVIDER, phone: 'not-a-phone' })
        .expect(400);
    });

    it('201 — valid phone passes validation', async () => {
      mockService.registerProvider.mockResolvedValue({ userId: 'p1', message: 'ok' });

      await request(app.getHttpServer())
        .post('/auth/register/provider')
        .send({ ...VALID_PROVIDER, phone: '+966512345678' })
        .expect(201);
    });
  });

  // ── POST /auth/login ─────────────────────────────────────────────────────────

  describe('POST /auth/login', () => {
    it('200 — happy path returns token pair', async () => {
      mockService.login.mockResolvedValue(TOKEN_PAIR);

      await request(app.getHttpServer())
        .post('/auth/login')
        .send(VALID_LOGIN)
        .expect(200)
        .expect((res) => {
          expect(res.body.accessToken).toBe(TOKEN_PAIR.accessToken);
          expect(res.body.tokenId).toBe(TOKEN_PAIR.tokenId);
          expect(res.body.refreshToken).toBe(TOKEN_PAIR.refreshToken);
          expect(res.body.expiresIn).toBe(900);
        });
    });

    it('400 — missing identifier fails validation', async () => {
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ password: 'SecurePass123!' })
        .expect(400);
    });

    it('400 — missing password fails validation', async () => {
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ identifier: 'sara@example.com' })
        .expect(400);
    });

    it('400 — password too short fails validation', async () => {
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ identifier: 'sara@example.com', password: 'short' })
        .expect(400);
    });

    it('400 — empty body fails validation', async () => {
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({})
        .expect(400);
    });
  });

  // ── POST /auth/token/refresh ─────────────────────────────────────────────────

  describe('POST /auth/token/refresh', () => {
    it('200 — happy path returns new token pair', async () => {
      mockService.refreshTokens.mockResolvedValue(TOKEN_PAIR);

      await request(app.getHttpServer())
        .post('/auth/token/refresh')
        .send(VALID_REFRESH)
        .expect(200)
        .expect((res) => {
          expect(res.body.accessToken).toBeDefined();
          expect(res.body.tokenId).toBeDefined();
        });
    });

    it('400 — missing tokenId fails validation', async () => {
      await request(app.getHttpServer())
        .post('/auth/token/refresh')
        .send({ refreshToken: 'some-token' })
        .expect(400);
    });

    it('400 — missing refreshToken fails validation', async () => {
      await request(app.getHttpServer())
        .post('/auth/token/refresh')
        .send({ tokenId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' })
        .expect(400);
    });

    it('400 — non-UUID tokenId fails validation', async () => {
      await request(app.getHttpServer())
        .post('/auth/token/refresh')
        .send({ tokenId: 'not-a-uuid', refreshToken: 'some-token' })
        .expect(400);
    });
  });

  // ── POST /auth/logout ────────────────────────────────────────────────────────

  describe('POST /auth/logout', () => {
    it('200 — happy path', async () => {
      mockService.logout.mockResolvedValue({ message: 'Logged out successfully' });

      await request(app.getHttpServer())
        .post('/auth/logout')
        .send({})
        .expect(200)
        .expect((res) => {
          expect(res.body.message).toBe('Logged out successfully');
        });
    });

    it('200 — with optional tokenId body', async () => {
      mockService.logout.mockResolvedValue({ message: 'Logged out successfully' });

      await request(app.getHttpServer())
        .post('/auth/logout')
        .send({ tokenId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' })
        .expect(200);
    });
  });

  // ── POST /auth/forgot-password ───────────────────────────────────────────────

  describe('POST /auth/forgot-password', () => {
    it('200 — happy path returns safe message', async () => {
      mockService.forgotPassword.mockResolvedValue({
        message: 'If that email is registered, a reset link has been sent.',
      });

      await request(app.getHttpServer())
        .post('/auth/forgot-password')
        .send({ email: 'sara@example.com' })
        .expect(200)
        .expect((res) => {
          expect(res.body.message).toBeDefined();
        });
    });

    it('400 — missing email fails validation', async () => {
      await request(app.getHttpServer())
        .post('/auth/forgot-password')
        .send({})
        .expect(400);
    });

    it('400 — invalid email format fails validation', async () => {
      await request(app.getHttpServer())
        .post('/auth/forgot-password')
        .send({ email: 'not-an-email' })
        .expect(400);
    });
  });

  // ── POST /auth/reset-password ────────────────────────────────────────────────

  describe('POST /auth/reset-password', () => {
    it('200 — happy path', async () => {
      mockService.resetPassword.mockResolvedValue({
        message: 'Password reset successfully. Please log in with your new password.',
      });

      await request(app.getHttpServer())
        .post('/auth/reset-password')
        .send({ token: 'user-id:hextoken', newPassword: 'NewSecure123!' })
        .expect(200)
        .expect((res) => {
          expect(res.body.message).toBeDefined();
        });
    });

    it('400 — missing token fails validation', async () => {
      await request(app.getHttpServer())
        .post('/auth/reset-password')
        .send({ newPassword: 'NewSecure123!' })
        .expect(400);
    });

    it('400 — missing newPassword fails validation', async () => {
      await request(app.getHttpServer())
        .post('/auth/reset-password')
        .send({ token: 'user-id:hextoken' })
        .expect(400);
    });

    it('400 — weak newPassword (no uppercase) fails validation', async () => {
      await request(app.getHttpServer())
        .post('/auth/reset-password')
        .send({ token: 'user-id:hextoken', newPassword: 'alllower1!' })
        .expect(400);
    });

    it('400 — newPassword shorter than 8 chars fails validation', async () => {
      await request(app.getHttpServer())
        .post('/auth/reset-password')
        .send({ token: 'user-id:hextoken', newPassword: 'Ab1' })
        .expect(400);
    });

    it('400 — newPassword with no digit fails validation', async () => {
      await request(app.getHttpServer())
        .post('/auth/reset-password')
        .send({ token: 'user-id:hextoken', newPassword: 'NoDigitHere!' })
        .expect(400);
    });
  });

  // ── GET /auth/verify-email ───────────────────────────────────────────────────

  describe('GET /auth/verify-email', () => {
    it('200 — happy path with valid token query param', async () => {
      mockService.verifyEmail.mockResolvedValue({
        message: 'Email verified successfully. You can now log in.',
      });

      await request(app.getHttpServer())
        .get('/auth/verify-email?token=user-id:abcdef1234')
        .expect(200)
        .expect((res) => {
          expect(res.body.message).toBeDefined();
        });

      expect(mockService.verifyEmail).toHaveBeenCalledWith('user-id:abcdef1234');
    });

    it('200 — missing token calls service with undefined (no DTO validation on query)', async () => {
      // GET /verify-email with no token — the controller still calls the service
      // which will throw BadRequestException; we verify the service was called
      mockService.verifyEmail.mockResolvedValue({ message: 'ok' });

      await request(app.getHttpServer())
        .get('/auth/verify-email')
        .expect(200);

      expect(mockService.verifyEmail).toHaveBeenCalledWith(undefined);
    });
  });

  // ── POST /auth/verify-email/resend ──────────────────────────────────────────

  describe('POST /auth/verify-email/resend', () => {
    it('200 — happy path', async () => {
      mockService.resendVerificationEmail.mockResolvedValue({
        message: 'If that email exists and is unverified, a link has been sent.',
      });

      await request(app.getHttpServer())
        .post('/auth/verify-email/resend')
        .send({ email: 'sara@example.com' })
        .expect(200)
        .expect((res) => {
          expect(res.body.message).toBeDefined();
        });
    });

    it('400 — missing email fails validation', async () => {
      await request(app.getHttpServer())
        .post('/auth/verify-email/resend')
        .send({})
        .expect(400);
    });

    it('400 — invalid email format fails validation', async () => {
      await request(app.getHttpServer())
        .post('/auth/verify-email/resend')
        .send({ email: 'not-an-email' })
        .expect(400);
    });
  });

  // ── GET /auth/me ──────────────────────────────────────────────────────────────

  describe('GET /auth/me', () => {
    it('200 — returns current user profile', async () => {
      mockService.getMe.mockResolvedValue({
        id: 'user-test-id',
        email: 'sara@example.com',
        username: 'sara_kh',
        role: 'CUSTOMER',
      });

      await request(app.getHttpServer())
        .get('/auth/me')
        .expect(200)
        .expect((res) => {
          expect(res.body.id).toBe('user-test-id');
          expect(res.body.email).toBe('sara@example.com');
        });

      expect(mockService.getMe).toHaveBeenCalledWith('user-test-id');
    });
  });

  // ── PATCH /auth/me/password ───────────────────────────────────────────────────

  describe('PATCH /auth/me/password', () => {
    it('200 — happy path', async () => {
      mockService.changePassword.mockResolvedValue({
        message: 'Password changed successfully. Please log in again.',
      });

      await request(app.getHttpServer())
        .patch('/auth/me/password')
        .send({ currentPassword: 'OldPass123!', newPassword: 'NewPass456!' })
        .expect(200)
        .expect((res) => {
          expect(res.body.message).toBeDefined();
        });

      expect(mockService.changePassword).toHaveBeenCalledWith(
        'user-test-id',
        'OldPass123!',
        'NewPass456!',
      );
    });

    it('400 — missing currentPassword fails validation', async () => {
      await request(app.getHttpServer())
        .patch('/auth/me/password')
        .send({ newPassword: 'NewPass456!' })
        .expect(400);
    });

    it('400 — missing newPassword fails validation', async () => {
      await request(app.getHttpServer())
        .patch('/auth/me/password')
        .send({ currentPassword: 'OldPass123!' })
        .expect(400);
    });

    it('400 — newPassword without uppercase fails validation', async () => {
      await request(app.getHttpServer())
        .patch('/auth/me/password')
        .send({ currentPassword: 'OldPass123!', newPassword: 'alllower1' })
        .expect(400);
    });

    it('400 — newPassword without digit fails validation', async () => {
      await request(app.getHttpServer())
        .patch('/auth/me/password')
        .send({ currentPassword: 'OldPass123!', newPassword: 'NoDigitHere' })
        .expect(400);
    });

    it('400 — newPassword shorter than 8 chars fails validation', async () => {
      await request(app.getHttpServer())
        .patch('/auth/me/password')
        .send({ currentPassword: 'OldPass123!', newPassword: 'Ab1' })
        .expect(400);
    });
  });
});
