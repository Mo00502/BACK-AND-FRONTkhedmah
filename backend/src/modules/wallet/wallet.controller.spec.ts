import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { WalletController } from './wallet.controller';
import { WalletService } from './wallet.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';

// ── Mock service ─────────────────────────────────────────────────────────────

const mockService = {
  getBalance: jest.fn(),
  getTransactions: jest.fn(),
  requestWithdrawal: jest.fn(),
  getWithdrawals: jest.fn(),
  adminListWithdrawals: jest.fn(),
  approveWithdrawal: jest.fn(),
  rejectWithdrawal: jest.fn(),
};

// Mock guards — always allow
const mockJwtGuard = { canActivate: jest.fn().mockReturnValue(true) };
const mockRolesGuard = { canActivate: jest.fn().mockReturnValue(true) };

// ── Fixtures ──────────────────────────────────────────────────────────────────

const WITHDRAWAL_ID = 'wr-abc-123';

const BALANCE_RESPONSE = {
  balance: 1500,
  heldBalance: 200,
  available: 1300,
};

const TRANSACTIONS_RESPONSE = {
  data: [
    {
      id: 'tx-1',
      type: 'CREDIT',
      amount: 500,
      description: 'Service payment received',
      createdAt: '2026-01-01T00:00:00.000Z',
    },
  ],
  total: 1,
  page: 1,
  limit: 20,
};

const VALID_WITHDRAWAL_BODY = {
  amount: 500,
  iban: 'SA0380000000608010167519',
  bankName: 'البنك الأهلي',
  beneficiaryName: 'محمد أحمد الغامدي',
};

const WITHDRAWAL_RESPONSE = {
  id: WITHDRAWAL_ID,
  amount: 500,
  iban: 'SA0380000000608010167519',
  status: 'PENDING',
};

const WITHDRAWALS_LIST_RESPONSE = {
  data: [WITHDRAWAL_RESPONSE],
  total: 1,
  page: 1,
  limit: 10,
};

// ─────────────────────────────────────────────────────────────────────────────

describe('WalletController (HTTP)', () => {
  let app: INestApplication;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [WalletController],
      providers: [{ provide: WalletService, useValue: mockService }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(mockJwtGuard)
      .overrideGuard(RolesGuard)
      .useValue(mockRolesGuard)
      .compile();

    app = module.createNestApplication();

    // Inject a fake authenticated user so @CurrentUser() works without JWT
    app.use((req: any, _res: any, next: any) => {
      req.user = { id: 'provider-user-1', role: 'PROVIDER' };
      next();
    });

    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));
    await app.init();
  });

  afterEach(() => app.close());

  // ── GET /wallet/balance ───────────────────────────────────────────────────────

  describe('GET /wallet/balance', () => {
    it('200 — returns wallet with balance, heldBalance, and available', async () => {
      mockService.getBalance.mockResolvedValue(BALANCE_RESPONSE);

      await request(app.getHttpServer())
        .get('/wallet/balance')
        .expect(200)
        .expect((res) => {
          expect(res.body.balance).toBe(1500);
          expect(res.body.heldBalance).toBe(200);
          expect(res.body.available).toBe(1300);
        });

      expect(mockService.getBalance).toHaveBeenCalledWith('provider-user-1');
    });
  });

  // ── GET /wallet/transactions ──────────────────────────────────────────────────

  describe('GET /wallet/transactions', () => {
    it('200 — returns paginated transactions with default page/limit', async () => {
      mockService.getTransactions.mockResolvedValue(TRANSACTIONS_RESPONSE);

      await request(app.getHttpServer())
        .get('/wallet/transactions')
        .expect(200)
        .expect((res) => {
          expect(Array.isArray(res.body.data)).toBe(true);
          expect(res.body.data[0].type).toBe('CREDIT');
        });

      expect(mockService.getTransactions).toHaveBeenCalledWith('provider-user-1', 1, 20);
    });

    it('200 — passes custom page and limit query params', async () => {
      mockService.getTransactions.mockResolvedValue({ data: [], total: 0, page: 2, limit: 5 });

      await request(app.getHttpServer())
        .get('/wallet/transactions?page=2&limit=5')
        .expect(200);

      expect(mockService.getTransactions).toHaveBeenCalledWith('provider-user-1', 2, 5);
    });
  });

  // ── POST /wallet/withdraw ─────────────────────────────────────────────────────

  describe('POST /wallet/withdraw', () => {
    it('201 — happy path creates withdrawal request', async () => {
      mockService.requestWithdrawal.mockResolvedValue(WITHDRAWAL_RESPONSE);

      await request(app.getHttpServer())
        .post('/wallet/withdraw')
        .send(VALID_WITHDRAWAL_BODY)
        .expect(201)
        .expect((res) => {
          expect(res.body.id).toBe(WITHDRAWAL_ID);
          expect(res.body.status).toBe('PENDING');
        });

      expect(mockService.requestWithdrawal).toHaveBeenCalledWith(
        'provider-user-1',
        VALID_WITHDRAWAL_BODY.amount,
        VALID_WITHDRAWAL_BODY.iban,
        VALID_WITHDRAWAL_BODY.bankName,
        VALID_WITHDRAWAL_BODY.beneficiaryName,
        undefined,
      );
    });

    it('201 — optional notes field is forwarded when provided', async () => {
      mockService.requestWithdrawal.mockResolvedValue(WITHDRAWAL_RESPONSE);

      await request(app.getHttpServer())
        .post('/wallet/withdraw')
        .send({ ...VALID_WITHDRAWAL_BODY, notes: 'Urgent withdrawal' })
        .expect(201);

      expect(mockService.requestWithdrawal).toHaveBeenCalledWith(
        'provider-user-1',
        VALID_WITHDRAWAL_BODY.amount,
        VALID_WITHDRAWAL_BODY.iban,
        VALID_WITHDRAWAL_BODY.bankName,
        VALID_WITHDRAWAL_BODY.beneficiaryName,
        'Urgent withdrawal',
      );
    });

    it('400 — missing amount fails validation', async () => {
      const { amount: _amount, ...body } = VALID_WITHDRAWAL_BODY;
      await request(app.getHttpServer())
        .post('/wallet/withdraw')
        .send(body)
        .expect(400);

      expect(mockService.requestWithdrawal).not.toHaveBeenCalled();
    });

    it('400 — amount below minimum (50) fails validation', async () => {
      await request(app.getHttpServer())
        .post('/wallet/withdraw')
        .send({ ...VALID_WITHDRAWAL_BODY, amount: 49 })
        .expect(400);

      expect(mockService.requestWithdrawal).not.toHaveBeenCalled();
    });

    it('400 — amount of zero fails validation', async () => {
      await request(app.getHttpServer())
        .post('/wallet/withdraw')
        .send({ ...VALID_WITHDRAWAL_BODY, amount: 0 })
        .expect(400);
    });

    it('400 — negative amount fails validation', async () => {
      await request(app.getHttpServer())
        .post('/wallet/withdraw')
        .send({ ...VALID_WITHDRAWAL_BODY, amount: -100 })
        .expect(400);
    });

    it('400 — missing iban fails validation', async () => {
      const { iban: _iban, ...body } = VALID_WITHDRAWAL_BODY;
      await request(app.getHttpServer())
        .post('/wallet/withdraw')
        .send(body)
        .expect(400);
    });

    it('400 — invalid IBAN format fails validation', async () => {
      await request(app.getHttpServer())
        .post('/wallet/withdraw')
        .send({ ...VALID_WITHDRAWAL_BODY, iban: 'NOT-AN-IBAN' })
        .expect(400);
    });

    it('400 — missing bankName fails validation', async () => {
      const { bankName: _bankName, ...body } = VALID_WITHDRAWAL_BODY;
      await request(app.getHttpServer())
        .post('/wallet/withdraw')
        .send(body)
        .expect(400);
    });

    it('400 — missing beneficiaryName fails validation', async () => {
      const { beneficiaryName: _beneficiaryName, ...body } = VALID_WITHDRAWAL_BODY;
      await request(app.getHttpServer())
        .post('/wallet/withdraw')
        .send(body)
        .expect(400);
    });

    it('400 — amount as string (not number) fails validation', async () => {
      await request(app.getHttpServer())
        .post('/wallet/withdraw')
        .send({ ...VALID_WITHDRAWAL_BODY, amount: '500' })
        .expect(400);
    });
  });

  // ── GET /wallet/withdrawals ───────────────────────────────────────────────────

  describe('GET /wallet/withdrawals', () => {
    it('200 — returns list of provider withdrawal requests', async () => {
      mockService.getWithdrawals.mockResolvedValue(WITHDRAWALS_LIST_RESPONSE);

      await request(app.getHttpServer())
        .get('/wallet/withdrawals')
        .expect(200)
        .expect((res) => {
          expect(Array.isArray(res.body.data)).toBe(true);
          expect(res.body.data[0].id).toBe(WITHDRAWAL_ID);
          expect(res.body.data[0].status).toBe('PENDING');
        });

      expect(mockService.getWithdrawals).toHaveBeenCalledWith('provider-user-1', 1, 10);
    });

    it('200 — passes custom page and limit query params', async () => {
      mockService.getWithdrawals.mockResolvedValue({ data: [], total: 0, page: 3, limit: 5 });

      await request(app.getHttpServer())
        .get('/wallet/withdrawals?page=3&limit=5')
        .expect(200);

      expect(mockService.getWithdrawals).toHaveBeenCalledWith('provider-user-1', 3, 5);
    });
  });

  // ── GET /wallet/admin/withdrawals ─────────────────────────────────────────────

  describe('GET /wallet/admin/withdrawals', () => {
    it('200 — returns pending withdrawals by default', async () => {
      mockService.adminListWithdrawals.mockResolvedValue({
        data: [WITHDRAWAL_RESPONSE],
        total: 1,
      });

      await request(app.getHttpServer())
        .get('/wallet/admin/withdrawals')
        .expect(200)
        .expect((res) => {
          expect(Array.isArray(res.body.data)).toBe(true);
        });

      expect(mockService.adminListWithdrawals).toHaveBeenCalledWith('PENDING', 1, 20);
    });

    it('200 — passes status=ALL query param', async () => {
      mockService.adminListWithdrawals.mockResolvedValue({ data: [], total: 0 });

      await request(app.getHttpServer())
        .get('/wallet/admin/withdrawals?status=ALL')
        .expect(200);

      expect(mockService.adminListWithdrawals).toHaveBeenCalledWith('ALL', 1, 20);
    });
  });

  // ── PATCH /wallet/admin/withdrawals/:id/approve ──────────────────────────────

  describe('PATCH /wallet/admin/withdrawals/:id/approve', () => {
    it('200 — happy path approves withdrawal', async () => {
      mockService.approveWithdrawal.mockResolvedValue({
        id: WITHDRAWAL_ID,
        status: 'APPROVED',
      });

      await request(app.getHttpServer())
        .patch(`/wallet/admin/withdrawals/${WITHDRAWAL_ID}/approve`)
        .send({})
        .expect(200)
        .expect((res) => {
          expect(res.body.status).toBe('APPROVED');
        });

      expect(mockService.approveWithdrawal).toHaveBeenCalledWith(
        WITHDRAWAL_ID,
        'provider-user-1',
        undefined,
      );
    });

    it('200 — with optional adminNote', async () => {
      mockService.approveWithdrawal.mockResolvedValue({ id: WITHDRAWAL_ID, status: 'APPROVED' });

      await request(app.getHttpServer())
        .patch(`/wallet/admin/withdrawals/${WITHDRAWAL_ID}/approve`)
        .send({ adminNote: 'Verified by finance team' })
        .expect(200);

      expect(mockService.approveWithdrawal).toHaveBeenCalledWith(
        WITHDRAWAL_ID,
        'provider-user-1',
        'Verified by finance team',
      );
    });
  });

  // ── PATCH /wallet/admin/withdrawals/:id/reject ───────────────────────────────

  describe('PATCH /wallet/admin/withdrawals/:id/reject', () => {
    it('200 — happy path rejects withdrawal', async () => {
      mockService.rejectWithdrawal.mockResolvedValue({
        id: WITHDRAWAL_ID,
        status: 'REJECTED',
      });

      await request(app.getHttpServer())
        .patch(`/wallet/admin/withdrawals/${WITHDRAWAL_ID}/reject`)
        .send({})
        .expect(200)
        .expect((res) => {
          expect(res.body.status).toBe('REJECTED');
        });

      // When adminNote is absent the controller falls back to 'No reason provided'
      expect(mockService.rejectWithdrawal).toHaveBeenCalledWith(
        WITHDRAWAL_ID,
        'provider-user-1',
        'No reason provided',
      );
    });

    it('200 — with optional adminNote passed through', async () => {
      mockService.rejectWithdrawal.mockResolvedValue({ id: WITHDRAWAL_ID, status: 'REJECTED' });

      await request(app.getHttpServer())
        .patch(`/wallet/admin/withdrawals/${WITHDRAWAL_ID}/reject`)
        .send({ adminNote: 'IBAN does not match records' })
        .expect(200);

      expect(mockService.rejectWithdrawal).toHaveBeenCalledWith(
        WITHDRAWAL_ID,
        'provider-user-1',
        'IBAN does not match records',
      );
    });
  });
});
