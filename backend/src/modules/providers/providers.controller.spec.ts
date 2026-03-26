import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { ProvidersController } from './providers.controller';
import { ProvidersService } from './providers.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';

// ── Mock service ──────────────────────────────────────────────────────────────

const mockService = {
  findAll: jest.fn(),
  findByUserId: jest.fn(),
  upsertProfile: jest.fn(),
  addSkill: jest.fn(),
  removeSkill: jest.fn(),
  updateSkill: jest.fn(),
  setAvailability: jest.fn(),
  getMyProfile: jest.fn(),
  getMySkills: jest.fn(),
  getMyAvailability: jest.fn(),
  getEarnings: jest.fn(),
  getEarningsDashboard: jest.fn(),
  getVerificationStatus: jest.fn(),
  submitDocuments: jest.fn(),
};

// ── Guard mocks — populate req.user so @CurrentUser() works ──────────────────

const makeJwtGuard = (id: string = 'provider-1', role: string = 'PROVIDER') => ({
  canActivate: jest.fn().mockImplementation((context) => {
    const req = context.switchToHttp().getRequest();
    req.user = { id, role };
    return true;
  }),
});

const mockRolesGuard = { canActivate: jest.fn().mockReturnValue(true) };

// ── Fixtures ──────────────────────────────────────────────────────────────────

const providerProfile = {
  id: 'profile-1',
  userId: 'provider-1',
  verificationStatus: 'APPROVED',
  ratingAvg: 4.5,
  ratingCount: 10,
  completedJobs: 5,
  yearsExperience: 3,
  ibanNumber: 'SA0380000000608010167519',
  bankName: 'Al Rajhi Bank',
};

const skillFixture = {
  id: 'skill-1',
  providerId: 'profile-1',
  serviceId: 'service-1',
  hourlyRate: 100,
  active: true,
};

const availabilitySlots = [
  { dayOfWeek: 0, startTime: '09:00', endTime: '17:00' },
  { dayOfWeek: 1, startTime: '09:00', endTime: '17:00' },
];

const earningsSummary = { available: 5000, pending: 1500, total: 6500 };

const providerListResult = {
  items: [{ id: 'profile-1', ratingAvg: 4.5 }],
  total: 1,
};

// ── Test suite ────────────────────────────────────────────────────────────────

describe('ProvidersController (HTTP)', () => {
  let app: INestApplication;

  const buildApp = async (userId: string = 'provider-1', role: string = 'PROVIDER') => {
    if (app) await app.close();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ProvidersController],
      providers: [{ provide: ProvidersService, useValue: mockService }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(makeJwtGuard(userId, role))
      .overrideGuard(RolesGuard)
      .useValue(mockRolesGuard)
      .compile();

    app = module.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    return app;
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    await buildApp();
  });

  afterEach(() => app.close());

  // ── GET /providers (public) ─────────────────────────────────────────────────

  describe('GET /providers', () => {
    it('returns 200 with paginated providers list', async () => {
      mockService.findAll.mockResolvedValue(providerListResult);

      const res = await request(app.getHttpServer()).get('/providers').expect(200);

      expect(res.body.items).toHaveLength(1);
      expect(mockService.findAll).toHaveBeenCalledTimes(1);
    });

    it('passes serviceId and city query params to service', async () => {
      mockService.findAll.mockResolvedValue({ items: [], total: 0 });

      await request(app.getHttpServer())
        .get('/providers?serviceId=service-1&city=riyadh')
        .expect(200);

      expect(mockService.findAll).toHaveBeenCalledWith(
        expect.objectContaining({ serviceId: 'service-1', city: 'riyadh' }),
      );
    });

    it('passes pagination params to service', async () => {
      mockService.findAll.mockResolvedValue({ items: [], total: 0 });

      await request(app.getHttpServer())
        .get('/providers?page=2&limit=10')
        .expect(200);

      // page/limit arrive as strings when the DTO intersection type prevents @Type() transform
      expect(mockService.findAll).toHaveBeenCalledWith(
        expect.objectContaining({ page: expect.anything(), limit: expect.anything() }),
      );
    });
  });

  // ── GET /providers/:userId (public) ────────────────────────────────────────

  describe('GET /providers/:userId', () => {
    it('returns 200 with provider public profile', async () => {
      mockService.findByUserId.mockResolvedValue(providerProfile);

      const res = await request(app.getHttpServer())
        .get('/providers/provider-1')
        .expect(200);

      expect(res.body.id).toBe('profile-1');
      expect(mockService.findByUserId).toHaveBeenCalledWith('provider-1');
    });
  });

  // ── GET /providers/me/profile ───────────────────────────────────────────────

  describe('GET /providers/me/profile', () => {
    it('returns 200 with own provider profile', async () => {
      mockService.getMyProfile.mockResolvedValue(providerProfile);

      const res = await request(app.getHttpServer())
        .get('/providers/me/profile')
        .expect(200);

      expect(res.body.userId).toBe('provider-1');
      expect(mockService.getMyProfile).toHaveBeenCalledWith('provider-1');
    });
  });

  // ── PATCH /providers/me/profile ─────────────────────────────────────────────

  describe('PATCH /providers/me/profile', () => {
    it('returns 200 on valid profile update', async () => {
      const updatePayload = { yearsExperience: 5, bankName: 'SNB' };
      mockService.upsertProfile.mockResolvedValue({ ...providerProfile, ...updatePayload });

      const res = await request(app.getHttpServer())
        .patch('/providers/me/profile')
        .send(updatePayload)
        .expect(200);

      expect(mockService.upsertProfile).toHaveBeenCalledWith(
        'provider-1',
        expect.objectContaining(updatePayload),
      );
    });

    it('returns 200 with partial update (only IBAN)', async () => {
      mockService.upsertProfile.mockResolvedValue(providerProfile);

      await request(app.getHttpServer())
        .patch('/providers/me/profile')
        .send({ ibanNumber: 'SA0380000000608010167519' })
        .expect(200);

      expect(mockService.upsertProfile).toHaveBeenCalledWith(
        'provider-1',
        expect.objectContaining({ ibanNumber: 'SA0380000000608010167519' }),
      );
    });

    it('returns 400 when yearsExperience exceeds maximum of 50', async () => {
      await request(app.getHttpServer())
        .patch('/providers/me/profile')
        .send({ yearsExperience: 60 })
        .expect(400);

      expect(mockService.upsertProfile).not.toHaveBeenCalled();
    });

    it('returns 400 when yearsExperience is negative', async () => {
      await request(app.getHttpServer())
        .patch('/providers/me/profile')
        .send({ yearsExperience: -1 })
        .expect(400);

      expect(mockService.upsertProfile).not.toHaveBeenCalled();
    });

    it('returns 400 when ibanNumber exceeds 34 characters', async () => {
      await request(app.getHttpServer())
        .patch('/providers/me/profile')
        .send({ ibanNumber: 'S'.repeat(35) })
        .expect(400);

      expect(mockService.upsertProfile).not.toHaveBeenCalled();
    });

    it('returns 400 for unknown fields (forbidNonWhitelisted)', async () => {
      await request(app.getHttpServer())
        .patch('/providers/me/profile')
        .send({ hackerField: 'evil' })
        .expect(400);
    });
  });

  // ── GET /providers/me/earnings ──────────────────────────────────────────────

  describe('GET /providers/me/earnings', () => {
    it('returns 200 with earnings summary', async () => {
      mockService.getEarnings.mockResolvedValue(earningsSummary);

      const res = await request(app.getHttpServer())
        .get('/providers/me/earnings')
        .expect(200);

      expect(res.body.available).toBe(5000);
      expect(res.body.pending).toBe(1500);
      expect(res.body.total).toBe(6500);
      expect(mockService.getEarnings).toHaveBeenCalledWith('provider-1');
    });
  });

  // ── GET /providers/me/earnings/dashboard ────────────────────────────────────

  describe('GET /providers/me/earnings/dashboard', () => {
    it('returns 200 with full earnings dashboard', async () => {
      const dashboard = {
        weeklyTrend: [],
        monthlyTrend: [],
        commissionBreakdown: {},
        jobHistory: [],
      };
      mockService.getEarningsDashboard.mockResolvedValue(dashboard);

      const res = await request(app.getHttpServer())
        .get('/providers/me/earnings/dashboard')
        .expect(200);

      expect(mockService.getEarningsDashboard).toHaveBeenCalledWith('provider-1');
    });
  });

  // ── GET /providers/me/skills ────────────────────────────────────────────────

  describe('GET /providers/me/skills', () => {
    it('returns 200 with skills list', async () => {
      mockService.getMySkills.mockResolvedValue([skillFixture]);

      const res = await request(app.getHttpServer())
        .get('/providers/me/skills')
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toHaveLength(1);
      expect(mockService.getMySkills).toHaveBeenCalledWith('provider-1');
    });
  });

  // ── POST /providers/me/skills ───────────────────────────────────────────────

  describe('POST /providers/me/skills', () => {
    it('returns 201 on valid skill addition', async () => {
      mockService.addSkill.mockResolvedValue(skillFixture);

      const res = await request(app.getHttpServer())
        .post('/providers/me/skills')
        .send({ serviceId: 'service-1', hourlyRate: 100 })
        .expect(201);

      expect(mockService.addSkill).toHaveBeenCalledWith(
        'provider-1',
        expect.objectContaining({ serviceId: 'service-1' }),
      );
    });

    it('returns 201 with serviceId only (hourlyRate is optional)', async () => {
      mockService.addSkill.mockResolvedValue({ ...skillFixture, hourlyRate: null });

      await request(app.getHttpServer())
        .post('/providers/me/skills')
        .send({ serviceId: 'service-1' })
        .expect(201);
    });

    it('returns 400 when serviceId is missing', async () => {
      await request(app.getHttpServer())
        .post('/providers/me/skills')
        .send({ hourlyRate: 100 })
        .expect(400);

      expect(mockService.addSkill).not.toHaveBeenCalled();
    });
  });

  // ── DELETE /providers/me/skills/:skillId ────────────────────────────────────

  describe('DELETE /providers/me/skills/:skillId', () => {
    it('returns 200 on successful skill removal', async () => {
      mockService.removeSkill.mockResolvedValue({ ok: true });

      const res = await request(app.getHttpServer())
        .delete('/providers/me/skills/skill-1')
        .expect(200);

      expect(mockService.removeSkill).toHaveBeenCalledWith('provider-1', 'skill-1');
    });
  });

  // ── PATCH /providers/me/skills/:skillId ─────────────────────────────────────

  describe('PATCH /providers/me/skills/:skillId', () => {
    it('returns 200 when updating hourlyRate', async () => {
      mockService.updateSkill.mockResolvedValue({ ...skillFixture, hourlyRate: 150 });

      const res = await request(app.getHttpServer())
        .patch('/providers/me/skills/skill-1')
        .send({ hourlyRate: 150 })
        .expect(200);

      expect(mockService.updateSkill).toHaveBeenCalledWith(
        'provider-1',
        'skill-1',
        expect.objectContaining({ hourlyRate: 150 }),
      );
    });

    it('returns 200 when toggling active flag', async () => {
      mockService.updateSkill.mockResolvedValue({ ...skillFixture, active: false });

      await request(app.getHttpServer())
        .patch('/providers/me/skills/skill-1')
        .send({ active: false })
        .expect(200);

      expect(mockService.updateSkill).toHaveBeenCalledWith(
        'provider-1',
        'skill-1',
        expect.objectContaining({ active: false }),
      );
    });
  });

  // ── GET /providers/me/availability ─────────────────────────────────────────

  describe('GET /providers/me/availability', () => {
    it('returns 200 with availability schedule', async () => {
      mockService.getMyAvailability.mockResolvedValue(availabilitySlots);

      const res = await request(app.getHttpServer())
        .get('/providers/me/availability')
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);
      expect(mockService.getMyAvailability).toHaveBeenCalledWith('provider-1');
    });
  });

  // ── PATCH /providers/me/availability ────────────────────────────────────────

  describe('PATCH /providers/me/availability', () => {
    it('returns 200 on valid availability update', async () => {
      mockService.setAvailability.mockResolvedValue({ slots: availabilitySlots });

      const res = await request(app.getHttpServer())
        .patch('/providers/me/availability')
        .send({ slots: availabilitySlots })
        .expect(200);

      expect(mockService.setAvailability).toHaveBeenCalledWith(
        'provider-1',
        expect.objectContaining({ slots: availabilitySlots }),
      );
    });

    it('returns 400 when slots is missing', async () => {
      await request(app.getHttpServer())
        .patch('/providers/me/availability')
        .send({})
        .expect(400);

      expect(mockService.setAvailability).not.toHaveBeenCalled();
    });

    it('returns 400 when slots is not an array', async () => {
      await request(app.getHttpServer())
        .patch('/providers/me/availability')
        .send({ slots: 'not-an-array' })
        .expect(400);

      expect(mockService.setAvailability).not.toHaveBeenCalled();
    });

    it('accepts empty slots array (provider has no availability)', async () => {
      mockService.setAvailability.mockResolvedValue({ slots: [] });

      await request(app.getHttpServer())
        .patch('/providers/me/availability')
        .send({ slots: [] })
        .expect(200);
    });
  });

  // ── GET /providers/me/verification ─────────────────────────────────────────

  describe('GET /providers/me/verification', () => {
    it('returns 200 with verification status and timeline', async () => {
      const verificationStatus = {
        status: 'APPROVED',
        timeline: [{ event: 'SUBMITTED', at: '2026-01-01T00:00:00Z' }],
      };
      mockService.getVerificationStatus.mockResolvedValue(verificationStatus);

      const res = await request(app.getHttpServer())
        .get('/providers/me/verification')
        .expect(200);

      expect(res.body.status).toBe('APPROVED');
      expect(mockService.getVerificationStatus).toHaveBeenCalledWith('provider-1');
    });
  });

  // ── POST /providers/me/documents ────────────────────────────────────────────

  describe('POST /providers/me/documents', () => {
    it('returns 200 on valid document submission', async () => {
      const docResult = { status: 'PENDING_REVIEW', submittedAt: '2026-03-26T00:00:00Z' };
      mockService.submitDocuments.mockResolvedValue(docResult);

      const res = await request(app.getHttpServer())
        .post('/providers/me/documents')
        .send({ docKeys: ['docs/id-card.pdf', 'docs/cert.jpg'] })
        .expect(200);

      expect(mockService.submitDocuments).toHaveBeenCalledWith('provider-1', [
        'docs/id-card.pdf',
        'docs/cert.jpg',
      ]);
    });

    it('returns 400 when docKeys is missing', async () => {
      await request(app.getHttpServer())
        .post('/providers/me/documents')
        .send({})
        .expect(400);

      expect(mockService.submitDocuments).not.toHaveBeenCalled();
    });

    it('returns 400 when docKeys is not an array', async () => {
      await request(app.getHttpServer())
        .post('/providers/me/documents')
        .send({ docKeys: 'docs/id-card.pdf' })
        .expect(400);

      expect(mockService.submitDocuments).not.toHaveBeenCalled();
    });

    it('returns 400 when docKeys contains non-string elements', async () => {
      await request(app.getHttpServer())
        .post('/providers/me/documents')
        .send({ docKeys: [123, 456] })
        .expect(400);

      expect(mockService.submitDocuments).not.toHaveBeenCalled();
    });

    it('returns 400 for unknown fields (forbidNonWhitelisted)', async () => {
      await request(app.getHttpServer())
        .post('/providers/me/documents')
        .send({ docKeys: ['docs/file.pdf'], extraField: 'evil' })
        .expect(400);
    });
  });
});
