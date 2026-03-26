import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { TendersController } from './tenders.controller';
import { TendersService } from './tenders.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';

// ── Mock service ──────────────────────────────────────────────────────────────

const mockService = {
  list: jest.fn(),
  myBids: jest.fn(),
  listCommissions: jest.fn(),
  get: jest.fn(),
  listBids: jest.fn(),
  create: jest.fn(),
  submitBid: jest.fn(),
  updateBid: jest.fn(),
  withdrawBid: jest.fn(),
  award: jest.fn(),
  updateCommissionStatus: jest.fn(),
  createRequirement: jest.fn(),
  listRequirements: jest.fn(),
  submitOffer: jest.fn(),
  selectOffer: jest.fn(),
};

// ── Guard mocks — populate req.user so @CurrentUser() works ──────────────────

const makeJwtGuard = (role: string = 'CUSTOMER') => ({
  canActivate: jest.fn().mockImplementation((context) => {
    const req = context.switchToHttp().getRequest();
    req.user = { id: 'user-1', role };
    return true;
  }),
});

const mockRolesGuard = { canActivate: jest.fn().mockReturnValue(true) };

// ── Fixtures ──────────────────────────────────────────────────────────────────

const tenderList = { items: [{ id: 'tndr-1', title: 'Test Tender' }], total: 1 };
const tenderDetail = { id: 'tndr-1', title: 'Test Tender', bids: [], requirements: [] };
const bidResult = { id: 'bid-1', tenderId: 'tndr-1', amount: 500_000 };
const awardResult = { ok: true, commissionAmount: 20_000 };
const commissionList = { items: [{ id: 'comm-1' }], total: 1 };

// ── Test suite ────────────────────────────────────────────────────────────────

describe('TendersController (HTTP)', () => {
  let app: INestApplication;
  let mockJwtGuard: ReturnType<typeof makeJwtGuard>;

  const buildApp = async (role: string = 'CUSTOMER') => {
    mockJwtGuard = makeJwtGuard(role);
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TendersController],
      providers: [{ provide: TendersService, useValue: mockService }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(mockJwtGuard)
      .overrideGuard(RolesGuard)
      .useValue(mockRolesGuard)
      .compile();

    app = module.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    await buildApp();
  });

  afterEach(() => app.close());

  // ── GET /tenders ────────────────────────────────────────────────────────────

  describe('GET /tenders', () => {
    it('returns 200 with tender list (public)', async () => {
      mockService.list.mockResolvedValue(tenderList);

      const res = await request(app.getHttpServer()).get('/tenders').expect(200);

      expect(res.body.items).toHaveLength(1);
      expect(mockService.list).toHaveBeenCalledTimes(1);
    });

    it('passes status/category/region query params to service', async () => {
      mockService.list.mockResolvedValue({ items: [], total: 0 });

      await request(app.getHttpServer())
        .get('/tenders?status=OPEN&category=construction&region=riyadh')
        .expect(200);

      expect(mockService.list).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'OPEN', category: 'construction', region: 'riyadh' }),
        expect.anything(),
      );
    });
  });

  // ── GET /tenders/my-bids ────────────────────────────────────────────────────

  describe('GET /tenders/my-bids', () => {
    it('returns 200 with provider bids', async () => {
      mockService.myBids.mockResolvedValue({ items: [bidResult], total: 1 });

      const res = await request(app.getHttpServer()).get('/tenders/my-bids').expect(200);

      expect(res.body.items).toHaveLength(1);
      expect(mockService.myBids).toHaveBeenCalledWith('user-1', expect.anything());
    });
  });

  // ── GET /tenders/commissions ────────────────────────────────────────────────

  describe('GET /tenders/commissions', () => {
    it('returns 200 with admin commissions list', async () => {
      mockService.listCommissions.mockResolvedValue(commissionList);

      const res = await request(app.getHttpServer()).get('/tenders/commissions').expect(200);

      expect(res.body.items).toHaveLength(1);
      expect(mockService.listCommissions).toHaveBeenCalledTimes(1);
    });

    it('passes status query param to service', async () => {
      mockService.listCommissions.mockResolvedValue({ items: [], total: 0 });

      await request(app.getHttpServer())
        .get('/tenders/commissions?status=PENDING')
        .expect(200);

      expect(mockService.listCommissions).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'PENDING' }),
        expect.anything(),
      );
    });
  });

  // ── GET /tenders/:id ────────────────────────────────────────────────────────

  describe('GET /tenders/:id', () => {
    it('returns 200 with tender detail (public)', async () => {
      mockService.get.mockResolvedValue(tenderDetail);

      const res = await request(app.getHttpServer()).get('/tenders/tndr-1').expect(200);

      expect(res.body.id).toBe('tndr-1');
      expect(mockService.get).toHaveBeenCalledWith('tndr-1', 'user-1');
    });
  });

  // ── GET /tenders/:id/bids ───────────────────────────────────────────────────

  describe('GET /tenders/:id/bids', () => {
    it('returns 200 with bid list for tender owner', async () => {
      mockService.listBids.mockResolvedValue({ items: [bidResult], total: 1 });

      const res = await request(app.getHttpServer()).get('/tenders/tndr-1/bids').expect(200);

      expect(res.body.items).toHaveLength(1);
      expect(mockService.listBids).toHaveBeenCalledWith('tndr-1', 'user-1', expect.anything());
    });
  });

  // ── POST /tenders ───────────────────────────────────────────────────────────

  describe('POST /tenders', () => {
    const validBody = {
      title: 'New Construction Tender',
      category: 'construction',
      region: 'riyadh',
      deadline: '2027-01-01T00:00:00Z',
    };

    it('returns 201 with created tender on valid body', async () => {
      mockService.create.mockResolvedValue({ id: 'tndr-2', ...validBody });

      const res = await request(app.getHttpServer())
        .post('/tenders')
        .send(validBody)
        .expect(201);

      expect(res.body.id).toBe('tndr-2');
      expect(mockService.create).toHaveBeenCalledWith('user-1', expect.objectContaining(validBody));
    });

    it('returns 400 when title is missing', async () => {
      const { title, ...bodyWithoutTitle } = validBody;
      await request(app.getHttpServer())
        .post('/tenders')
        .send(bodyWithoutTitle)
        .expect(400);

      expect(mockService.create).not.toHaveBeenCalled();
    });

    it('returns 400 when deadline is missing', async () => {
      const { deadline, ...bodyWithoutDeadline } = validBody;
      await request(app.getHttpServer())
        .post('/tenders')
        .send(bodyWithoutDeadline)
        .expect(400);

      expect(mockService.create).not.toHaveBeenCalled();
    });

    it('returns 400 when category is missing', async () => {
      const { category, ...bodyWithoutCategory } = validBody;
      await request(app.getHttpServer())
        .post('/tenders')
        .send(bodyWithoutCategory)
        .expect(400);

      expect(mockService.create).not.toHaveBeenCalled();
    });

    it('returns 400 when region is missing', async () => {
      const { region, ...bodyWithoutRegion } = validBody;
      await request(app.getHttpServer())
        .post('/tenders')
        .send(bodyWithoutRegion)
        .expect(400);

      expect(mockService.create).not.toHaveBeenCalled();
    });

    it('returns 400 when unknown fields are sent (forbidNonWhitelisted)', async () => {
      await request(app.getHttpServer())
        .post('/tenders')
        .send({ ...validBody, hackerField: 'evil' })
        .expect(400);
    });
  });

  // ── POST /tenders/:id/bids ──────────────────────────────────────────────────

  describe('POST /tenders/:id/bids', () => {
    const validBid = { amount: 500_000 };

    it('returns 201 on valid bid submission', async () => {
      mockService.submitBid.mockResolvedValue(bidResult);

      const res = await request(app.getHttpServer())
        .post('/tenders/tndr-1/bids')
        .send(validBid)
        .expect(201);

      expect(res.body.id).toBe('bid-1');
      expect(mockService.submitBid).toHaveBeenCalledWith(
        'tndr-1',
        'user-1',
        expect.objectContaining({ amount: 500_000 }),
      );
    });

    it('returns 400 when amount is missing', async () => {
      await request(app.getHttpServer())
        .post('/tenders/tndr-1/bids')
        .send({})
        .expect(400);

      expect(mockService.submitBid).not.toHaveBeenCalled();
    });

    it('returns 400 when amount is zero or negative', async () => {
      await request(app.getHttpServer())
        .post('/tenders/tndr-1/bids')
        .send({ amount: -100 })
        .expect(400);

      expect(mockService.submitBid).not.toHaveBeenCalled();
    });

    it('returns 400 when durationMonths exceeds maximum of 120', async () => {
      await request(app.getHttpServer())
        .post('/tenders/tndr-1/bids')
        .send({ amount: 500_000, durationMonths: 200 })
        .expect(400);
    });

    it('includes optional fields when provided', async () => {
      mockService.submitBid.mockResolvedValue(bidResult);

      await request(app.getHttpServer())
        .post('/tenders/tndr-1/bids')
        .send({ amount: 500_000, durationMonths: 12, note: 'Best offer', termsAccepted: true })
        .expect(201);

      expect(mockService.submitBid).toHaveBeenCalledWith(
        'tndr-1',
        'user-1',
        expect.objectContaining({
          amount: 500_000,
          durationMonths: 12,
          note: 'Best offer',
          termsAccepted: true,
        }),
      );
    });
  });

  // ── PATCH /tenders/:id/bids/:bidId ─────────────────────────────────────────

  describe('PATCH /tenders/:id/bids/:bidId', () => {
    it('returns 200 on successful bid update', async () => {
      const updated = { ...bidResult, amount: 450_000 };
      mockService.updateBid.mockResolvedValue(updated);

      const res = await request(app.getHttpServer())
        .patch('/tenders/tndr-1/bids/bid-1')
        .send({ amount: 450_000 })
        .expect(200);

      expect(res.body.amount).toBe(450_000);
      expect(mockService.updateBid).toHaveBeenCalledWith(
        'tndr-1',
        'bid-1',
        'user-1',
        expect.objectContaining({ amount: 450_000 }),
      );
    });

    it('returns 200 when updating only note', async () => {
      mockService.updateBid.mockResolvedValue({ ...bidResult, note: 'Updated note' });

      await request(app.getHttpServer())
        .patch('/tenders/tndr-1/bids/bid-1')
        .send({ note: 'Updated note' })
        .expect(200);
    });

    it('returns 400 when amount is zero or negative', async () => {
      await request(app.getHttpServer())
        .patch('/tenders/tndr-1/bids/bid-1')
        .send({ amount: 0 })
        .expect(400);
    });
  });

  // ── DELETE /tenders/:id/bids/:bidId ────────────────────────────────────────

  describe('DELETE /tenders/:id/bids/:bidId', () => {
    it('returns 200 on successful bid withdrawal', async () => {
      mockService.withdrawBid.mockResolvedValue({ ok: true });

      const res = await request(app.getHttpServer())
        .delete('/tenders/tndr-1/bids/bid-1')
        .expect(200);

      expect(res.body.ok).toBe(true);
      expect(mockService.withdrawBid).toHaveBeenCalledWith('tndr-1', 'bid-1', 'user-1');
    });
  });

  // ── POST /tenders/:id/award/:bidId ─────────────────────────────────────────

  describe('POST /tenders/:id/award/:bidId', () => {
    it('returns 200 on successful award', async () => {
      mockService.award.mockResolvedValue(awardResult);

      const res = await request(app.getHttpServer())
        .post('/tenders/tndr-1/award/bid-1')
        .expect(200);

      expect(res.body.ok).toBe(true);
      expect(res.body.commissionAmount).toBe(20_000);
      expect(mockService.award).toHaveBeenCalledWith('tndr-1', 'bid-1', 'user-1');
    });
  });

  // ── PATCH /tenders/commissions/:id/status ──────────────────────────────────

  describe('PATCH /tenders/commissions/:id/status', () => {
    it('returns 200 with valid commission status', async () => {
      mockService.updateCommissionStatus.mockResolvedValue({ id: 'comm-1', status: 'INVOICE_ISSUED' });

      const res = await request(app.getHttpServer())
        .patch('/tenders/commissions/comm-1/status')
        .send({ status: 'INVOICE_ISSUED' })
        .expect(200);

      expect(mockService.updateCommissionStatus).toHaveBeenCalledWith(
        'comm-1',
        'INVOICE_ISSUED',
        'user-1',
      );
    });

    it('returns 400 when status is not a valid CommissionStatus enum value', async () => {
      await request(app.getHttpServer())
        .patch('/tenders/commissions/comm-1/status')
        .send({ status: 'INVALID_STATUS' })
        .expect(400);

      expect(mockService.updateCommissionStatus).not.toHaveBeenCalled();
    });
  });

  // ── POST /tenders/:tenderId/requirements ────────────────────────────────────

  describe('POST /tenders/:tenderId/requirements', () => {
    const validRequirement = {
      nameAr: 'متطلبات المشروع',
      type: 'MATERIAL',
    };

    it('returns 201 on valid requirement creation', async () => {
      mockService.createRequirement.mockResolvedValue({ id: 'req-1', ...validRequirement });

      const res = await request(app.getHttpServer())
        .post('/tenders/tndr-1/requirements')
        .send(validRequirement)
        .expect(201);

      expect(mockService.createRequirement).toHaveBeenCalledWith(
        'tndr-1',
        'user-1',
        expect.objectContaining(validRequirement),
      );
    });

    it('returns 400 when nameAr is missing', async () => {
      await request(app.getHttpServer())
        .post('/tenders/tndr-1/requirements')
        .send({ type: 'MATERIAL' })
        .expect(400);
    });

    it('returns 400 when type is missing', async () => {
      await request(app.getHttpServer())
        .post('/tenders/tndr-1/requirements')
        .send({ nameAr: 'متطلب ما' })
        .expect(400);
    });
  });

  // ── GET /tenders/:tenderId/requirements ─────────────────────────────────────

  describe('GET /tenders/:tenderId/requirements', () => {
    it('returns 200 with requirements list', async () => {
      mockService.listRequirements.mockResolvedValue([{ id: 'req-1', nameAr: 'متطلب' }]);

      const res = await request(app.getHttpServer())
        .get('/tenders/tndr-1/requirements')
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);
      expect(mockService.listRequirements).toHaveBeenCalledWith('tndr-1');
    });
  });

  // ── POST /tenders/requirements/:requirementId/offers ────────────────────────

  describe('POST /tenders/requirements/:requirementId/offers', () => {
    const validOffer = { priceTotal: 15_000 };

    it('returns 201 on valid offer submission', async () => {
      mockService.submitOffer.mockResolvedValue({ id: 'offer-1', priceTotal: 15_000 });

      const res = await request(app.getHttpServer())
        .post('/tenders/requirements/req-1/offers')
        .send(validOffer)
        .expect(201);

      expect(mockService.submitOffer).toHaveBeenCalledWith(
        'req-1',
        'user-1',
        expect.objectContaining({ priceTotal: 15_000 }),
      );
    });

    it('returns 400 when priceTotal is missing', async () => {
      await request(app.getHttpServer())
        .post('/tenders/requirements/req-1/offers')
        .send({})
        .expect(400);

      expect(mockService.submitOffer).not.toHaveBeenCalled();
    });

    it('returns 400 when priceTotal is zero or negative', async () => {
      await request(app.getHttpServer())
        .post('/tenders/requirements/req-1/offers')
        .send({ priceTotal: 0 })
        .expect(400);
    });
  });

  // ── POST /tenders/requirements/:requirementId/offers/:offerId/select ─────────

  describe('POST /tenders/requirements/:requirementId/offers/:offerId/select', () => {
    it('returns 200 on successful offer selection', async () => {
      mockService.selectOffer.mockResolvedValue({ ok: true });

      const res = await request(app.getHttpServer())
        .post('/tenders/requirements/req-1/offers/offer-1/select')
        .expect(200);

      expect(res.body.ok).toBe(true);
      expect(mockService.selectOffer).toHaveBeenCalledWith('offer-1', 'req-1', 'user-1');
    });
  });
});
