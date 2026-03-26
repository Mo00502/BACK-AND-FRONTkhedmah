import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { RequestsController } from './requests.controller';
import { RequestsService } from './requests.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';

const mockService = {
  create: jest.fn(),
  findMyRequests: jest.fn(),
  findById: jest.fn(),
  cancel: jest.fn(),
  submitQuote: jest.fn(),
  acceptQuote: jest.fn(),
  startWork: jest.fn(),
  completeWork: jest.fn(),
};

const mockJwtGuard = { canActivate: jest.fn().mockReturnValue(true) };
const mockRolesGuard = { canActivate: jest.fn().mockReturnValue(true) };

/**
 * Helper: attach a fake CurrentUser to the request so that @CurrentUser()
 * decorator can extract id and role from req.user.
 */
function withUser(role = 'CUSTOMER') {
  return (req: any, _res: any, next: any) => {
    req.user = { id: 'user-1', role };
    next();
  };
}

describe('RequestsController (HTTP)', () => {
  let app: INestApplication;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [RequestsController],
      providers: [{ provide: RequestsService, useValue: mockService }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(mockJwtGuard)
      .overrideGuard(RolesGuard)
      .useValue(mockRolesGuard)
      .compile();

    app = module.createNestApplication();
    // Inject fake user before validation pipe runs
    app.use(withUser('CUSTOMER'));
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
  });

  afterEach(() => app.close());

  // ── POST /requests ──────────────────────────────────────────────────────────

  describe('POST /requests', () => {
    const validBody = {
      serviceId: 'svc-123',
      city: 'الرياض',
      description: 'أحتاج إصلاح تسريب في الحمام',
    };

    it('returns 201 with a created request on valid body', async () => {
      const created = { id: 'req-1', ...validBody };
      mockService.create.mockResolvedValue(created);

      const res = await request(app.getHttpServer())
        .post('/requests')
        .send(validBody)
        .expect(201);

      expect(res.body).toEqual(created);
      expect(mockService.create).toHaveBeenCalledWith('user-1', expect.objectContaining(validBody));
    });

    it('returns 400 when serviceId is missing', async () => {
      await request(app.getHttpServer())
        .post('/requests')
        .send({ city: 'الرياض', description: 'test' })
        .expect(400);

      expect(mockService.create).not.toHaveBeenCalled();
    });

    it('returns 400 when description is missing', async () => {
      await request(app.getHttpServer())
        .post('/requests')
        .send({ serviceId: 'svc-1', city: 'الرياض' })
        .expect(400);

      expect(mockService.create).not.toHaveBeenCalled();
    });

    it('returns 400 when city is missing', async () => {
      await request(app.getHttpServer())
        .post('/requests')
        .send({ serviceId: 'svc-1', description: 'test description' })
        .expect(400);

      expect(mockService.create).not.toHaveBeenCalled();
    });

    it('passes optional fields through when supplied', async () => {
      const body = {
        ...validBody,
        urgency: 'urgent',
        indoorOutdoor: 'indoor',
        scheduledAt: '2026-05-01T10:00:00.000Z',
      };
      mockService.create.mockResolvedValue({ id: 'req-2', ...body });

      await request(app.getHttpServer()).post('/requests').send(body).expect(201);

      expect(mockService.create).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({ urgency: 'urgent', indoorOutdoor: 'indoor' }),
      );
    });
  });

  // ── GET /requests ───────────────────────────────────────────────────────────

  describe('GET /requests', () => {
    it('returns 200 with paginated list', async () => {
      const paginated = { items: [{ id: 'req-1' }], total: 1, page: 1, limit: 20 };
      mockService.findMyRequests.mockResolvedValue(paginated);

      const res = await request(app.getHttpServer()).get('/requests').expect(200);

      expect(res.body).toEqual(paginated);
      expect(mockService.findMyRequests).toHaveBeenCalledWith(
        'user-1',
        'CUSTOMER',
        expect.any(Object),
      );
    });

    it('forwards status query param to service', async () => {
      mockService.findMyRequests.mockResolvedValue({ items: [], total: 0, page: 1, limit: 20 });

      await request(app.getHttpServer()).get('/requests?status=PENDING').expect(200);

      expect(mockService.findMyRequests).toHaveBeenCalledWith(
        'user-1',
        'CUSTOMER',
        expect.objectContaining({ status: 'PENDING' }),
      );
    });
  });

  // ── GET /requests/:id ───────────────────────────────────────────────────────

  describe('GET /requests/:id', () => {
    it('returns 200 with request details', async () => {
      const found = { id: 'req-1', city: 'الرياض' };
      mockService.findById.mockResolvedValue(found);

      const res = await request(app.getHttpServer()).get('/requests/req-1').expect(200);

      expect(res.body).toEqual(found);
      expect(mockService.findById).toHaveBeenCalledWith('req-1', 'user-1', 'CUSTOMER');
    });
  });

  // ── PATCH /requests/:id/cancel ──────────────────────────────────────────────

  describe('PATCH /requests/:id/cancel', () => {
    it('returns 200 on successful cancellation', async () => {
      const cancelled = { id: 'req-1', status: 'CANCELLED' };
      mockService.cancel.mockResolvedValue(cancelled);

      const res = await request(app.getHttpServer()).patch('/requests/req-1/cancel').expect(200);

      expect(res.body).toEqual(cancelled);
      expect(mockService.cancel).toHaveBeenCalledWith('req-1', 'user-1');
    });
  });

  // ── POST /requests/:id/quotes ───────────────────────────────────────────────

  describe('POST /requests/:id/quotes', () => {
    const validQuote = { amount: 250 };

    it('returns 201 on a valid quote submission', async () => {
      const quote = { id: 'quote-1', amount: 250 };
      mockService.submitQuote.mockResolvedValue(quote);

      const res = await request(app.getHttpServer())
        .post('/requests/req-1/quotes')
        .send(validQuote)
        .expect(201);

      expect(res.body).toEqual(quote);
      expect(mockService.submitQuote).toHaveBeenCalledWith(
        'user-1',
        'req-1',
        expect.objectContaining({ amount: 250 }),
      );
    });

    it('returns 400 when amount is missing', async () => {
      await request(app.getHttpServer())
        .post('/requests/req-1/quotes')
        .send({ message: 'no amount here' })
        .expect(400);

      expect(mockService.submitQuote).not.toHaveBeenCalled();
    });

    it('returns 400 when amount is below minimum (0)', async () => {
      await request(app.getHttpServer())
        .post('/requests/req-1/quotes')
        .send({ amount: 0 })
        .expect(400);

      expect(mockService.submitQuote).not.toHaveBeenCalled();
    });

    it('passes optional fields through when supplied', async () => {
      const body = { amount: 300, includesMaterials: true, message: 'سأحضر الأدوات' };
      mockService.submitQuote.mockResolvedValue({ id: 'quote-2', ...body });

      await request(app.getHttpServer())
        .post('/requests/req-1/quotes')
        .send(body)
        .expect(201);

      expect(mockService.submitQuote).toHaveBeenCalledWith(
        'user-1',
        'req-1',
        expect.objectContaining({ includesMaterials: true }),
      );
    });
  });

  // ── PATCH /requests/:id/quotes/:quoteId/accept ──────────────────────────────

  describe('PATCH /requests/:id/quotes/:quoteId/accept', () => {
    it('returns 200 on successful quote acceptance', async () => {
      const updated = { id: 'req-1', status: 'ACCEPTED' };
      mockService.acceptQuote.mockResolvedValue(updated);

      const res = await request(app.getHttpServer())
        .patch('/requests/req-1/quotes/quote-1/accept')
        .expect(200);

      expect(res.body).toEqual(updated);
      expect(mockService.acceptQuote).toHaveBeenCalledWith('user-1', 'req-1', 'quote-1');
    });
  });

  // ── PATCH /requests/:id/start ───────────────────────────────────────────────

  describe('PATCH /requests/:id/start', () => {
    it('returns 200 when provider starts work', async () => {
      const updated = { id: 'req-1', status: 'IN_PROGRESS' };
      mockService.startWork.mockResolvedValue(updated);

      const res = await request(app.getHttpServer()).patch('/requests/req-1/start').expect(200);

      expect(res.body).toEqual(updated);
      expect(mockService.startWork).toHaveBeenCalledWith('user-1', 'req-1');
    });
  });

  // ── PATCH /requests/:id/complete ────────────────────────────────────────────

  describe('PATCH /requests/:id/complete', () => {
    it('returns 200 when provider marks work as completed', async () => {
      const updated = { id: 'req-1', status: 'COMPLETED' };
      mockService.completeWork.mockResolvedValue(updated);

      const res = await request(app.getHttpServer()).patch('/requests/req-1/complete').expect(200);

      expect(res.body).toEqual(updated);
      expect(mockService.completeWork).toHaveBeenCalledWith('user-1', 'req-1');
    });
  });
});
