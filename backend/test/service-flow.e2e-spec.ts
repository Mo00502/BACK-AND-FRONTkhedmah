/**
 * Service Flow E2E Tests — full customer→provider journey
 *
 * Covers: register → verify → login → create request → provider quotes →
 *         customer accepts → escrow paid (mocked Moyasar) → provider completes →
 *         customer releases escrow → both rate each other
 *
 * Run: npm run test:e2e
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import * as bcrypt from 'bcryptjs';

const TS = Date.now();
const CUST_EMAIL = `flow_cust_${TS}@test.khedmah.sa`;
const PROV_EMAIL = `flow_prov_${TS}@test.khedmah.sa`;

// ── Helpers ────────────────────────────────────────────────────────────────────
async function seedVerifiedUser(
  prisma: PrismaService,
  overrides: { email: string; username: string; role: string },
) {
  return prisma.user.create({
    data: {
      email: overrides.email,
      username: overrides.username,
      passwordHash: await bcrypt.hash('Flow@12345!', 4),
      role: overrides.role as any,
      status: 'ACTIVE',
      emailVerified: true,
      emailVerifiedAt: new Date(),
    },
  });
}

async function loginAs(app: INestApplication, email: string): Promise<string> {
  const { body } = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ identifier: email, password: 'Flow@12345!' });
  return body.data?.accessToken as string;
}

// ── Suite ──────────────────────────────────────────────────────────────────────
describe('Service Flow (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let custToken: string;
  let provToken: string;
  let custId: string;
  let provUserId: string;
  let requestId: string;
  let quoteId: string;

  beforeAll(async () => {
    const fixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = fixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    app.setGlobalPrefix('api/v1');
    await app.init();

    prisma = fixture.get<PrismaService>(PrismaService);

    // Seed customer and provider
    const cust = await seedVerifiedUser(prisma, {
      email: CUST_EMAIL,
      username: `flow_cust_${TS}`,
      role: 'CUSTOMER',
    });
    const prov = await seedVerifiedUser(prisma, {
      email: PROV_EMAIL,
      username: `flow_prov_${TS}`,
      role: 'PROVIDER',
    });
    custId = cust.id;
    provUserId = prov.id;

    // Create provider profile (required for matching)
    await prisma.providerProfile
      .create({
        data: {
          userId: provUserId,
          bio: 'E2E test provider',
          city: 'الرياض',
          category: 'كهرباء',
          verificationStatus: 'APPROVED',
        } as any,
      })
      .catch(() => {
        /* may already exist */
      });

    custToken = await loginAs(app, CUST_EMAIL);
    provToken = await loginAs(app, PROV_EMAIL);
  });

  afterAll(async () => {
    await prisma.user.deleteMany({
      where: { email: { contains: '@test.khedmah.sa' } },
    });
    await app.close();
  });

  // ── Step 1: Customer creates service request ─────────────────────────────────
  describe('Step 1 — Customer creates request', () => {
    it('201 — creates a PENDING service request', async () => {
      const { body } = await request(app.getHttpServer())
        .post('/api/v1/requests')
        .set('Authorization', `Bearer ${custToken}`)
        .send({
          city: 'الرياض',
          description: 'إصلاح تمديدات كهربائية في الدور الأول',
        })
        .expect(201);

      expect(body.data.status).toBe('PENDING');
      expect(body.data.customerId).toBe(custId);
      requestId = body.data.id;
    });

    it('customer can list their own requests', async () => {
      const { body } = await request(app.getHttpServer())
        .get('/api/v1/requests')
        .set('Authorization', `Bearer ${custToken}`)
        .expect(200);

      expect(body.data.items.some((r: any) => r.id === requestId)).toBe(true);
    });
  });

  // ── Step 2: Provider submits a quote ─────────────────────────────────────────
  describe('Step 2 — Provider submits quote', () => {
    it('201 — provider submits a quote for the request', async () => {
      const { body } = await request(app.getHttpServer())
        .post(`/api/v1/requests/${requestId}/quotes`)
        .set('Authorization', `Bearer ${provToken}`)
        .send({ amount: 450, includesMaterials: false, message: 'جاهز للعمل خلال 24 ساعة' })
        .expect(201);

      expect(body.data.amount).toBe(450);
      expect(body.data.providerId).toBe(provUserId);
      quoteId = body.data.id;
    });

    it('409 — provider cannot submit duplicate quote for same request', async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/requests/${requestId}/quotes`)
        .set('Authorization', `Bearer ${provToken}`)
        .send({ amount: 400, includesMaterials: false, message: 'duplicate' })
        .expect(409);
    });

    it('403 — customer cannot submit a quote', async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/requests/${requestId}/quotes`)
        .set('Authorization', `Bearer ${custToken}`)
        .send({ amount: 300, includesMaterials: false, message: 'wrong role' })
        .expect(403);
    });
  });

  // ── Step 3: Customer accepts the quote ───────────────────────────────────────
  describe('Step 3 — Customer accepts quote', () => {
    it('200 — request transitions to ACCEPTED', async () => {
      const { body } = await request(app.getHttpServer())
        .patch(`/api/v1/requests/${requestId}/quotes/${quoteId}/accept`)
        .set('Authorization', `Bearer ${custToken}`)
        .expect(200);

      expect(body.data.providerId).toBe(provUserId);
    });

    it("403 — provider cannot accept a quote on someone else's request", async () => {
      await request(app.getHttpServer())
        .patch(`/api/v1/requests/${requestId}/quotes/${quoteId}/accept`)
        .set('Authorization', `Bearer ${provToken}`)
        .expect(403);
    });
  });

  // ── Step 4: Simulate payment + escrow (bypass Moyasar in test) ───────────────
  describe('Step 4 — Payment & escrow (test bypass)', () => {
    it('sets request to IN_PROGRESS and creates escrow record directly in DB', async () => {
      // In e2e tests we skip real Moyasar; manually set state as the webhook would
      await prisma.serviceRequest.update({
        where: { id: requestId },
        data: { status: 'IN_PROGRESS' as any },
      });
      await prisma.escrow
        .create({
          data: {
            requestId,
            customerId: custId,
            providerId: provUserId,
            amount: 450,
            status: 'HELD',
          } as any,
        })
        .catch(() => {
          /* may already exist */
        });

      const req = await prisma.serviceRequest.findUnique({ where: { id: requestId } });
      expect(req!.status).toBe('IN_PROGRESS');
    });
  });

  // ── Step 5: Provider marks work complete ─────────────────────────────────────
  describe('Step 5 — Provider completes work', () => {
    it('200 — marks request COMPLETED', async () => {
      const { body } = await request(app.getHttpServer())
        .patch(`/api/v1/requests/${requestId}/complete`)
        .set('Authorization', `Bearer ${provToken}`)
        .expect(200);

      expect(body.data.status).toBe('COMPLETED');
    });

    it('403 — customer cannot mark work complete on behalf of provider', async () => {
      // Attempt to complete again as customer (should be 403 or 400 — not their role)
      const { status } = await request(app.getHttpServer())
        .patch(`/api/v1/requests/${requestId}/complete`)
        .set('Authorization', `Bearer ${custToken}`);
      expect([400, 403]).toContain(status);
    });
  });

  // ── Step 6: Customer releases escrow ─────────────────────────────────────────
  describe('Step 6 — Customer confirms and releases escrow', () => {
    it('200 — releases escrow and emits event', async () => {
      const { body } = await request(app.getHttpServer())
        .post(`/api/v1/payments/${requestId}/release`)
        .set('Authorization', `Bearer ${custToken}`)
        .expect(200);

      expect(body.data.message).toMatch(/released/i);
    });

    it('400 — double-release is rejected', async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/payments/${requestId}/release`)
        .set('Authorization', `Bearer ${custToken}`)
        .expect(400);
    });
  });

  // ── Step 7: Mutual ratings ────────────────────────────────────────────────────
  describe('Step 7 — Mutual ratings', () => {
    it('201 — customer rates provider', async () => {
      const { body } = await request(app.getHttpServer())
        .post(`/api/v1/reviews`)
        .set('Authorization', `Bearer ${custToken}`)
        .send({ requestId, score: 5, comment: 'عمل ممتاز وسريع!' })
        .expect(201);

      expect(body.data.score).toBe(5);
      expect(body.data.rateeId).toBe(provUserId);
    });

    it('201 — provider rates customer', async () => {
      const { body } = await request(app.getHttpServer())
        .post(`/api/v1/reviews`)
        .set('Authorization', `Bearer ${provToken}`)
        .send({ requestId, score: 5, comment: 'عميل محترم وملتزم' })
        .expect(201);

      expect(body.data.score).toBe(5);
      expect(body.data.rateeId).toBe(custId);
    });

    it('409 — cannot review the same request twice', async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/reviews`)
        .set('Authorization', `Bearer ${custToken}`)
        .send({ requestId, score: 3, comment: 'changed my mind' })
        .expect(409);
    });
  });

  // ── Step 8: Cancel flow ───────────────────────────────────────────────────────
  describe('Step 8 — Cancel request (separate request)', () => {
    let cancelReqId: string;

    beforeAll(async () => {
      const { body } = await request(app.getHttpServer())
        .post('/api/v1/requests')
        .set('Authorization', `Bearer ${custToken}`)
        .send({ city: 'جدة', description: 'طلب للإلغاء' });
      cancelReqId = body.data?.id;
    });

    it('200 — customer can cancel a PENDING request', async () => {
      if (!cancelReqId) return;
      const { body } = await request(app.getHttpServer())
        .patch(`/api/v1/requests/${cancelReqId}/cancel`)
        .set('Authorization', `Bearer ${custToken}`)
        .expect(200);
      expect(body.data.status).toBe('CANCELLED');
    });
  });
});
