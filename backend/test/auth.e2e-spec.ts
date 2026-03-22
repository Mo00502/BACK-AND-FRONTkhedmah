/**
 * Auth E2E Tests — email+password flow
 * Run: npm run test:e2e
 * Requires DATABASE_URL and REDIS_URL pointing to test instances.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

// ── Test fixtures ──────────────────────────────────────────────────────────────
const TS = Date.now();
const TEST_EMAIL = `e2e_${TS}@test.khedmah.sa`;
const TEST_USER = `e2e_${TS}`;
const TEST_PASS = 'Test@12345!';

// ── Helpers ────────────────────────────────────────────────────────────────────
async function forceVerifyEmail(prisma: PrismaService, email: string) {
  await prisma.user.update({
    where: { email },
    data: { emailVerified: true, emailVerifiedAt: new Date(), status: 'ACTIVE' },
  });
}

// ── Suite ──────────────────────────────────────────────────────────────────────
describe('Auth (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    const fixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = fixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    app.setGlobalPrefix('api/v1');
    await app.init();

    prisma = fixture.get<PrismaService>(PrismaService);
  });

  afterAll(async () => {
    await prisma.user.deleteMany({
      where: { email: { contains: '@test.khedmah.sa' } },
    });
    await app.close();
  });

  // ── POST /auth/register/customer ────────────────────────────────────────────
  describe('POST /api/v1/auth/register/customer', () => {
    it('201 — creates customer and returns confirmation message', async () => {
      const { body } = await request(app.getHttpServer())
        .post('/api/v1/auth/register/customer')
        .send({ email: TEST_EMAIL, username: TEST_USER, password: TEST_PASS, name: 'E2E Test' })
        .expect(201);

      expect(body.data.message).toMatch(/verify/i);
    });

    it('409 — rejects duplicate email', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/auth/register/customer')
        .send({ email: TEST_EMAIL, username: `${TEST_USER}_dup`, password: TEST_PASS })
        .expect(409);
    });

    it('409 — rejects duplicate username', async () => {
      const newEmail = `e2e_dup_${TS}@test.khedmah.sa`;
      await request(app.getHttpServer())
        .post('/api/v1/auth/register/customer')
        .send({ email: newEmail, username: TEST_USER, password: TEST_PASS })
        .expect(409);
    });

    it('400 — rejects invalid email format', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/auth/register/customer')
        .send({ email: 'not-an-email', username: 'some_user', password: TEST_PASS })
        .expect(400);
    });

    it('400 — rejects weak password', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/auth/register/customer')
        .send({
          email: `e2e_weak_${TS}@test.khedmah.sa`,
          username: `e2e_weak_${TS}`,
          password: '123',
        })
        .expect(400);
    });
  });

  // ── POST /auth/login (before email verification) ────────────────────────────
  describe('POST /api/v1/auth/login — unverified email', () => {
    it('403 — rejects login before email is verified', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ identifier: TEST_EMAIL, password: TEST_PASS })
        .expect(403);
    });
  });

  // ── POST /auth/login (after force-verify) ───────────────────────────────────
  describe('POST /api/v1/auth/login — verified user', () => {
    let accessToken: string;
    let refreshToken: string;
    let tokenId: string;

    beforeAll(async () => {
      await forceVerifyEmail(prisma, TEST_EMAIL);
    });

    it('200 — returns token triple on valid credentials', async () => {
      const { body } = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ identifier: TEST_EMAIL, password: TEST_PASS })
        .expect(200);

      expect(body.data).toHaveProperty('accessToken');
      expect(body.data).toHaveProperty('refreshToken');
      expect(body.data).toHaveProperty('tokenId');
      accessToken = body.data.accessToken;
      refreshToken = body.data.refreshToken;
      tokenId = body.data.tokenId;
    });

    it('200 — allows login by username (not just email)', async () => {
      const { body } = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ identifier: TEST_USER, password: TEST_PASS })
        .expect(200);
      expect(body.data.accessToken).toBeDefined();
    });

    it('401 — rejects wrong password', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ identifier: TEST_EMAIL, password: 'WrongPass!9' })
        .expect(401);
    });

    it('401 — rejects unknown identifier', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ identifier: 'nobody@nowhere.com', password: TEST_PASS })
        .expect(401);
    });

    // ── GET /users/me (protected) ────────────────────────────────────────────
    describe('GET /api/v1/users/me', () => {
      it('200 — returns user profile with valid token', async () => {
        const { body } = await request(app.getHttpServer())
          .get('/api/v1/users/me')
          .set('Authorization', `Bearer ${accessToken}`)
          .expect(200);

        expect(body.data.email).toBe(TEST_EMAIL);
        expect(body.data.role).toBe('CUSTOMER');
        expect(body.data).not.toHaveProperty('passwordHash');
      });

      it('401 — rejects request without token', async () => {
        await request(app.getHttpServer()).get('/api/v1/users/me').expect(401);
      });

      it('401 — rejects tampered token', async () => {
        await request(app.getHttpServer())
          .get('/api/v1/users/me')
          .set('Authorization', 'Bearer invalid.jwt.token')
          .expect(401);
      });
    });

    // ── POST /auth/refresh ───────────────────────────────────────────────────
    describe('POST /api/v1/auth/refresh', () => {
      it('201 — issues new token pair for valid refresh token', async () => {
        const { body } = await request(app.getHttpServer())
          .post('/api/v1/auth/refresh')
          .send({ tokenId, refreshToken })
          .expect(201);

        expect(body.data.accessToken).toBeDefined();
        expect(body.data.tokenId).toBeDefined();
        // Update for next tests
        tokenId = body.data.tokenId;
      });

      it('401 — rejects already-rotated (used) refresh token', async () => {
        // The refresh token from the first login was just rotated — using it again should fail
        await request(app.getHttpServer())
          .post('/api/v1/auth/refresh')
          .send({ tokenId, refreshToken })
          .expect(401);
      });
    });

    // ── POST /auth/logout ────────────────────────────────────────────────────
    describe('POST /api/v1/auth/logout', () => {
      it('200 — invalidates current session token', async () => {
        await request(app.getHttpServer())
          .post('/api/v1/auth/logout')
          .set('Authorization', `Bearer ${accessToken}`)
          .send({ tokenId })
          .expect(200);
      });
    });
  });

  // ── POST /auth/forgot-password ───────────────────────────────────────────────
  describe('POST /api/v1/auth/forgot-password', () => {
    it('200 — always returns same message (no email enumeration)', async () => {
      const r1 = await request(app.getHttpServer())
        .post('/api/v1/auth/forgot-password')
        .send({ email: TEST_EMAIL })
        .expect(200);

      const r2 = await request(app.getHttpServer())
        .post('/api/v1/auth/forgot-password')
        .send({ email: 'nobody@example.com' })
        .expect(200);

      expect(r1.body.data.message).toBe(r2.body.data.message);
    });
  });

  // ── Health check (sanity) ────────────────────────────────────────────────────
  describe('GET /api/v1/health/live', () => {
    it('200 — returns ok', async () => {
      const { body } = await request(app.getHttpServer()).get('/api/v1/health/live').expect(200);
      expect(body.status).toBe('ok');
    });
  });
});
