import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { ConsultationsController } from './consultations.controller';
import { ConsultationsService } from './consultations.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';

// ── Mock service ──────────────────────────────────────────────────────────────

const mockService = {
  findAll: jest.fn(),
  create: jest.fn(),
  findMine: jest.fn(),
  findById: jest.fn(),
  cancel: jest.fn(),
  cancelByProvider: jest.fn(),
  rate: jest.fn(),
  accept: jest.fn(),
  reject: jest.fn(),
  startSession: jest.fn(),
  complete: jest.fn(),
};

// ── Guard mocks — populate req.user so @CurrentUser() works ──────────────────

const makeJwtGuard = (id: string = 'user-1', role: string = 'CUSTOMER') => ({
  canActivate: jest.fn().mockImplementation((context) => {
    const req = context.switchToHttp().getRequest();
    req.user = { id, role };
    return true;
  }),
});

const mockRolesGuard = { canActivate: jest.fn().mockReturnValue(true) };

// ── Fixtures ──────────────────────────────────────────────────────────────────

const consultationFixture = {
  id: 'consult-1',
  customerId: 'customer-1',
  providerId: null,
  serviceId: 'service-1',
  status: 'PENDING',
  topic: 'استشارة كهربائية',
};

const completedConsultation = { ...consultationFixture, status: 'COMPLETED', rating: null };

// ── Test suite ────────────────────────────────────────────────────────────────

describe('ConsultationsController (HTTP)', () => {
  let app: INestApplication;

  // Helper: rebuild app with a specific user context
  const buildApp = async (userId: string = 'customer-1', role: string = 'CUSTOMER') => {
    if (app) await app.close();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ConsultationsController],
      providers: [{ provide: ConsultationsService, useValue: mockService }],
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
    await buildApp(); // default: customer-1 / CUSTOMER
  });

  afterEach(() => app.close());

  // ── GET /consultations/all (admin) ──────────────────────────────────────────

  describe('GET /consultations/all', () => {
    it('returns 200 with all consultations for admin', async () => {
      mockService.findAll.mockResolvedValue({ items: [consultationFixture], total: 1 });

      await buildApp('admin-1', 'ADMIN');
      const res = await request(app.getHttpServer()).get('/consultations/all').expect(200);

      expect(res.body.items).toHaveLength(1);
      expect(mockService.findAll).toHaveBeenCalledTimes(1);
    });

    it('passes status filter to service', async () => {
      mockService.findAll.mockResolvedValue({ items: [], total: 0 });

      await buildApp('admin-1', 'ADMIN');
      await request(app.getHttpServer())
        .get('/consultations/all?status=PENDING')
        .expect(200);

      expect(mockService.findAll).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'PENDING' }),
      );
    });
  });

  // ── POST /consultations ─────────────────────────────────────────────────────

  describe('POST /consultations', () => {
    const validBody = {
      serviceId: 'service-1',
      topic: 'استشارة في تصميم الشبكة الكهربائية',
    };

    it('returns 201 with created consultation on valid body', async () => {
      mockService.create.mockResolvedValue(consultationFixture);

      const res = await request(app.getHttpServer())
        .post('/consultations')
        .send(validBody)
        .expect(201);

      expect(res.body.id).toBe('consult-1');
      expect(mockService.create).toHaveBeenCalledWith(
        'customer-1',
        expect.objectContaining(validBody),
      );
    });

    it('returns 400 when topic is missing', async () => {
      await request(app.getHttpServer())
        .post('/consultations')
        .send({ serviceId: 'service-1' })
        .expect(400);

      expect(mockService.create).not.toHaveBeenCalled();
    });

    it('returns 400 when serviceId is missing', async () => {
      await request(app.getHttpServer())
        .post('/consultations')
        .send({ topic: 'استشارة' })
        .expect(400);

      expect(mockService.create).not.toHaveBeenCalled();
    });

    it('returns 400 when topic exceeds 200 characters', async () => {
      const longTopic = 'a'.repeat(201);
      await request(app.getHttpServer())
        .post('/consultations')
        .send({ serviceId: 'service-1', topic: longTopic })
        .expect(400);

      expect(mockService.create).not.toHaveBeenCalled();
    });

    it('returns 400 when durationMinutes is below minimum of 15', async () => {
      await request(app.getHttpServer())
        .post('/consultations')
        .send({ ...validBody, durationMinutes: 10 })
        .expect(400);
    });

    it('returns 400 when durationMinutes exceeds maximum of 480', async () => {
      await request(app.getHttpServer())
        .post('/consultations')
        .send({ ...validBody, durationMinutes: 500 })
        .expect(400);
    });

    it('accepts valid optional fields', async () => {
      mockService.create.mockResolvedValue(consultationFixture);

      await request(app.getHttpServer())
        .post('/consultations')
        .send({
          ...validBody,
          durationMinutes: 60,
          mode: 'CHAT',
          scheduledAt: '2027-01-01T10:00:00Z',
          pricePerHour: 150,
        })
        .expect(201);
    });

    it('returns 400 for unknown fields (forbidNonWhitelisted)', async () => {
      await request(app.getHttpServer())
        .post('/consultations')
        .send({ ...validBody, unknownField: 'evil' })
        .expect(400);
    });
  });

  // ── GET /consultations ──────────────────────────────────────────────────────

  describe('GET /consultations', () => {
    it('returns 200 with paginated consultations list', async () => {
      mockService.findMine.mockResolvedValue({ items: [consultationFixture], total: 1 });

      const res = await request(app.getHttpServer()).get('/consultations').expect(200);

      expect(res.body.items).toHaveLength(1);
      expect(mockService.findMine).toHaveBeenCalledWith(
        'customer-1',
        'CUSTOMER',
        expect.anything(),
      );
    });

    it('passes status filter to service', async () => {
      mockService.findMine.mockResolvedValue({ items: [], total: 0 });

      await request(app.getHttpServer())
        .get('/consultations?status=COMPLETED')
        .expect(200);

      expect(mockService.findMine).toHaveBeenCalledWith(
        'customer-1',
        'CUSTOMER',
        expect.objectContaining({ status: 'COMPLETED' }),
      );
    });
  });

  // ── GET /consultations/:id ──────────────────────────────────────────────────

  describe('GET /consultations/:id', () => {
    it('returns 200 with consultation detail', async () => {
      mockService.findById.mockResolvedValue(consultationFixture);

      const res = await request(app.getHttpServer())
        .get('/consultations/consult-1')
        .expect(200);

      expect(res.body.id).toBe('consult-1');
      expect(mockService.findById).toHaveBeenCalledWith('consult-1', 'customer-1', 'CUSTOMER');
    });
  });

  // ── PATCH /consultations/:id/accept ────────────────────────────────────────

  describe('PATCH /consultations/:id/accept', () => {
    it('returns 200 when provider accepts consultation', async () => {
      mockService.accept.mockResolvedValue({ ...consultationFixture, status: 'ACCEPTED' });

      await buildApp('provider-1', 'PROVIDER');
      const res = await request(app.getHttpServer())
        .patch('/consultations/consult-1/accept')
        .expect(200);

      expect(res.body.status).toBe('ACCEPTED');
      expect(mockService.accept).toHaveBeenCalledWith('provider-1', 'consult-1');
    });
  });

  // ── PATCH /consultations/:id/reject ────────────────────────────────────────

  describe('PATCH /consultations/:id/reject', () => {
    it('returns 200 when provider rejects consultation', async () => {
      mockService.reject.mockResolvedValue({ ...consultationFixture, status: 'REJECTED' });

      await buildApp('provider-1', 'PROVIDER');
      const res = await request(app.getHttpServer())
        .patch('/consultations/consult-1/reject')
        .expect(200);

      expect(res.body.status).toBe('REJECTED');
      expect(mockService.reject).toHaveBeenCalledWith('provider-1', 'consult-1');
    });
  });

  // ── PATCH /consultations/:id/start ─────────────────────────────────────────

  describe('PATCH /consultations/:id/start', () => {
    it('returns 200 when provider starts the session', async () => {
      mockService.startSession.mockResolvedValue({ ...consultationFixture, status: 'IN_SESSION' });

      await buildApp('provider-1', 'PROVIDER');
      const res = await request(app.getHttpServer())
        .patch('/consultations/consult-1/start')
        .expect(200);

      expect(res.body.status).toBe('IN_SESSION');
      expect(mockService.startSession).toHaveBeenCalledWith('provider-1', 'consult-1');
    });
  });

  // ── PATCH /consultations/:id/complete ──────────────────────────────────────

  describe('PATCH /consultations/:id/complete', () => {
    it('returns 200 when provider marks session as completed', async () => {
      mockService.complete.mockResolvedValue({ ...consultationFixture, status: 'COMPLETED' });

      await buildApp('provider-1', 'PROVIDER');
      const res = await request(app.getHttpServer())
        .patch('/consultations/consult-1/complete')
        .expect(200);

      expect(res.body.status).toBe('COMPLETED');
      expect(mockService.complete).toHaveBeenCalledWith('provider-1', 'consult-1', undefined);
    });

    it('passes notes body field to service when provided', async () => {
      mockService.complete.mockResolvedValue({ ...consultationFixture, status: 'COMPLETED' });

      await buildApp('provider-1', 'PROVIDER');
      await request(app.getHttpServer())
        .patch('/consultations/consult-1/complete')
        .send({ notes: 'تم الانتهاء من الجلسة بنجاح' })
        .expect(200);

      expect(mockService.complete).toHaveBeenCalledWith(
        'provider-1',
        'consult-1',
        'تم الانتهاء من الجلسة بنجاح',
      );
    });
  });

  // ── PATCH /consultations/:id/cancel ────────────────────────────────────────

  describe('PATCH /consultations/:id/cancel', () => {
    it('returns 200 when customer cancels a consultation', async () => {
      mockService.cancel.mockResolvedValue({ ...consultationFixture, status: 'CANCELLED' });

      const res = await request(app.getHttpServer())
        .patch('/consultations/consult-1/cancel')
        .expect(200);

      expect(res.body.status).toBe('CANCELLED');
      expect(mockService.cancel).toHaveBeenCalledWith('customer-1', 'consult-1');
    });
  });

  // ── PATCH /consultations/:id/provider-cancel ────────────────────────────────

  describe('PATCH /consultations/:id/provider-cancel', () => {
    it('returns 200 when provider cancels a consultation', async () => {
      mockService.cancelByProvider.mockResolvedValue({
        ...consultationFixture,
        status: 'CANCELLED',
      });

      await buildApp('provider-1', 'PROVIDER');
      const res = await request(app.getHttpServer())
        .patch('/consultations/consult-1/provider-cancel')
        .expect(200);

      expect(res.body.status).toBe('CANCELLED');
      expect(mockService.cancelByProvider).toHaveBeenCalledWith('provider-1', 'consult-1');
    });
  });

  // ── POST /consultations/:id/rate ────────────────────────────────────────────

  describe('POST /consultations/:id/rate', () => {
    it('returns 201 with valid rating (1–5 integer)', async () => {
      mockService.rate.mockResolvedValue({ ...completedConsultation, rating: 5 });

      const res = await request(app.getHttpServer())
        .post('/consultations/consult-1/rate')
        .send({ rating: 5 })
        .expect(201);

      expect(mockService.rate).toHaveBeenCalledWith(
        'customer-1',
        'consult-1',
        expect.objectContaining({ rating: 5 }),
      );
    });

    it('returns 201 with optional notes field', async () => {
      mockService.rate.mockResolvedValue({ ...completedConsultation, rating: 4 });

      await request(app.getHttpServer())
        .post('/consultations/consult-1/rate')
        .send({ rating: 4, notes: 'خبرة عالية وشرح واضح' })
        .expect(201);

      expect(mockService.rate).toHaveBeenCalledWith(
        'customer-1',
        'consult-1',
        expect.objectContaining({ rating: 4, notes: 'خبرة عالية وشرح واضح' }),
      );
    });

    it('returns 400 when rating is missing', async () => {
      await request(app.getHttpServer())
        .post('/consultations/consult-1/rate')
        .send({})
        .expect(400);

      expect(mockService.rate).not.toHaveBeenCalled();
    });

    it('returns 400 when rating exceeds 5', async () => {
      await request(app.getHttpServer())
        .post('/consultations/consult-1/rate')
        .send({ rating: 6 })
        .expect(400);

      expect(mockService.rate).not.toHaveBeenCalled();
    });

    it('returns 400 when rating is below 1', async () => {
      await request(app.getHttpServer())
        .post('/consultations/consult-1/rate')
        .send({ rating: 0 })
        .expect(400);

      expect(mockService.rate).not.toHaveBeenCalled();
    });

    it('returns 400 when rating is not an integer (float)', async () => {
      await request(app.getHttpServer())
        .post('/consultations/consult-1/rate')
        .send({ rating: 4.5 })
        .expect(400);

      expect(mockService.rate).not.toHaveBeenCalled();
    });

    it('returns 400 when notes exceed 500 characters', async () => {
      await request(app.getHttpServer())
        .post('/consultations/consult-1/rate')
        .send({ rating: 5, notes: 'a'.repeat(501) })
        .expect(400);

      expect(mockService.rate).not.toHaveBeenCalled();
    });

    it('returns 400 for unknown fields (forbidNonWhitelisted)', async () => {
      await request(app.getHttpServer())
        .post('/consultations/consult-1/rate')
        .send({ rating: 5, evilField: 'hack' })
        .expect(400);
    });
  });
});
