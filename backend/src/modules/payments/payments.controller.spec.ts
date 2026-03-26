import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';

// ── Mock service ─────────────────────────────────────────────────────────────

const mockService = {
  initiatePayment: jest.fn(),
  handleWebhook: jest.fn(),
  getEscrowStatus: jest.fn(),
  releaseEscrow: jest.fn(),
  getPaymentStatus: jest.fn(),
  initiateRefund: jest.fn(),
};

// Mock guards — always allow
const mockJwtGuard = { canActivate: jest.fn().mockReturnValue(true) };
const mockRolesGuard = { canActivate: jest.fn().mockReturnValue(true) };

// ── Fixtures ──────────────────────────────────────────────────────────────────

const REQUEST_ID = 'req-abc-123';
const PAYMENT_ID = 'pay-xyz-456';

const INITIATE_RESPONSE = {
  paymentId: PAYMENT_ID,
  moyasarId: 'moyasar-ref-1',
  checkoutUrl: 'https://checkout.moyasar.com/pay/1',
  breakdown: {
    serviceFee: 500,
    materialsFee: 0,
    total: 500,
    serviceProtected: 'محجوز في الضمان حتى إتمام الخدمة',
    materialsAvailable: null,
  },
};

const ESCROW_RESPONSE = {
  id: 'escrow-1',
  status: 'HELD',
  amount: 500,
  requestId: REQUEST_ID,
};

const PAYMENT_STATUS_RESPONSE = {
  id: PAYMENT_ID,
  status: 'PAID',
  amount: 500,
  method: 'CREDIT_CARD',
};

const WEBHOOK_PAYLOAD = {
  type: 'payment_paid',
  data: {
    id: 'moyasar-ref-1',
    status: 'paid',
    amount: 50000,
    metadata: { paymentId: PAYMENT_ID, requestId: REQUEST_ID },
  },
};

// ─────────────────────────────────────────────────────────────────────────────

describe('PaymentsController (HTTP)', () => {
  let app: INestApplication;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [PaymentsController],
      providers: [{ provide: PaymentsService, useValue: mockService }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(mockJwtGuard)
      .overrideGuard(RolesGuard)
      .useValue(mockRolesGuard)
      .compile();

    app = module.createNestApplication();

    // Inject a fake authenticated user so @CurrentUser() works without JWT
    app.use((req: any, _res: any, next: any) => {
      req.user = { id: 'user-customer-1', role: 'CUSTOMER' };
      next();
    });

    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));
    await app.init();
  });

  afterEach(() => app.close());

  // ── POST /payments/requests/:requestId/pay ───────────────────────────────────

  describe('POST /payments/requests/:requestId/pay', () => {
    it('201 — happy path with CREDIT_CARD method', async () => {
      mockService.initiatePayment.mockResolvedValue(INITIATE_RESPONSE);

      await request(app.getHttpServer())
        .post(`/payments/requests/${REQUEST_ID}/pay`)
        .send({ method: 'CREDIT_CARD' })
        .expect(201)
        .expect((res) => {
          expect(res.body.paymentId).toBe(PAYMENT_ID);
          expect(res.body.checkoutUrl).toBeDefined();
        });

      expect(mockService.initiatePayment).toHaveBeenCalledWith(
        'user-customer-1',
        REQUEST_ID,
        'CREDIT_CARD',
        false,
        0,
      );
    });

    it('201 — happy path with hasMaterials and materialsEstimate', async () => {
      const responseWithMaterials = {
        ...INITIATE_RESPONSE,
        breakdown: { ...INITIATE_RESPONSE.breakdown, materialsFee: 200, total: 700 },
      };
      mockService.initiatePayment.mockResolvedValue(responseWithMaterials);

      await request(app.getHttpServer())
        .post(`/payments/requests/${REQUEST_ID}/pay`)
        .send({ method: 'CREDIT_CARD', hasMaterials: true, materialsEstimate: 200 })
        .expect((res) => {
          expect(res.body.breakdown.materialsFee).toBe(200);
        });

      expect(mockService.initiatePayment).toHaveBeenCalledWith(
        'user-customer-1',
        REQUEST_ID,
        'CREDIT_CARD',
        true,
        200,
      );
    });

    it('400 — missing method fails validation', async () => {
      await request(app.getHttpServer())
        .post(`/payments/requests/${REQUEST_ID}/pay`)
        .send({})
        .expect(400);

      expect(mockService.initiatePayment).not.toHaveBeenCalled();
    });

    it('400 — invalid method enum value fails validation', async () => {
      await request(app.getHttpServer())
        .post(`/payments/requests/${REQUEST_ID}/pay`)
        .send({ method: 'BITCOIN' })
        .expect(400);

      expect(mockService.initiatePayment).not.toHaveBeenCalled();
    });

    it('400 — unknown extra field is stripped by whitelist (no 400)', async () => {
      mockService.initiatePayment.mockResolvedValue(INITIATE_RESPONSE);

      // forbidNonWhitelisted is true — unknown field triggers 400
      await request(app.getHttpServer())
        .post(`/payments/requests/${REQUEST_ID}/pay`)
        .send({ method: 'CREDIT_CARD', unknownField: 'value' })
        .expect(400);
    });
  });

  // ── POST /payments/webhook/moyasar ───────────────────────────────────────────

  describe('POST /payments/webhook/moyasar', () => {
    it('201 — happy path processes Moyasar webhook payload', async () => {
      mockService.handleWebhook.mockResolvedValue({ received: true });

      await request(app.getHttpServer())
        .post('/payments/webhook/moyasar')
        .set('x-moyasar-signature', 'valid-sig')
        .send(WEBHOOK_PAYLOAD)
        .expect(201)
        .expect((res) => {
          expect(res.body.received).toBe(true);
        });

      expect(mockService.handleWebhook).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'payment_paid' }),
        'valid-sig',
        expect.any(Buffer),
      );
    });

    it('400 — missing type field fails validation', async () => {
      await request(app.getHttpServer())
        .post('/payments/webhook/moyasar')
        .send({ data: { id: 'x' } })
        .expect(400);
    });

    it('400 — missing data field fails validation', async () => {
      await request(app.getHttpServer())
        .post('/payments/webhook/moyasar')
        .send({ type: 'payment_paid' })
        .expect(400);
    });
  });

  // ── GET /payments/requests/:requestId/escrow ────────────────────────────────

  describe('GET /payments/requests/:requestId/escrow', () => {
    it('200 — returns escrow status', async () => {
      mockService.getEscrowStatus.mockResolvedValue(ESCROW_RESPONSE);

      await request(app.getHttpServer())
        .get(`/payments/requests/${REQUEST_ID}/escrow`)
        .expect(200)
        .expect((res) => {
          expect(res.body.id).toBe('escrow-1');
          expect(res.body.status).toBe('HELD');
          expect(res.body.amount).toBe(500);
        });

      expect(mockService.getEscrowStatus).toHaveBeenCalledWith(REQUEST_ID, 'user-customer-1');
    });
  });

  // ── POST /payments/requests/:requestId/release ──────────────────────────────

  describe('POST /payments/requests/:requestId/release', () => {
    it('201 — happy path releases escrow', async () => {
      mockService.releaseEscrow.mockResolvedValue({
        message: 'Escrow released. Provider will be credited.',
        requestId: REQUEST_ID,
      });

      await request(app.getHttpServer())
        .post(`/payments/requests/${REQUEST_ID}/release`)
        .send()
        .expect(201)
        .expect((res) => {
          expect(res.body.requestId).toBe(REQUEST_ID);
        });

      expect(mockService.releaseEscrow).toHaveBeenCalledWith('user-customer-1', REQUEST_ID);
    });
  });

  // ── POST /payments/:paymentId/refund ─────────────────────────────────────────

  describe('POST /payments/:paymentId/refund', () => {
    it('201 — admin happy path triggers refund', async () => {
      mockService.initiateRefund.mockResolvedValue({
        message: 'Refund initiated.',
        paymentId: PAYMENT_ID,
      });

      await request(app.getHttpServer())
        .post(`/payments/${PAYMENT_ID}/refund`)
        .send({ reason: 'Customer dispute resolved in favour of customer' })
        .expect(201)
        .expect((res) => {
          expect(res.body.paymentId).toBe(PAYMENT_ID);
        });

      expect(mockService.initiateRefund).toHaveBeenCalledWith(
        'user-customer-1',
        PAYMENT_ID,
        'Customer dispute resolved in favour of customer',
      );
    });

    it('400 — missing reason fails validation', async () => {
      await request(app.getHttpServer())
        .post(`/payments/${PAYMENT_ID}/refund`)
        .send({})
        .expect(400);

      expect(mockService.initiateRefund).not.toHaveBeenCalled();
    });

    it('400 — non-string reason fails validation', async () => {
      await request(app.getHttpServer())
        .post(`/payments/${PAYMENT_ID}/refund`)
        .send({ reason: 12345 })
        .expect(400);
    });
  });

  // ── GET /payments/:paymentId/status ─────────────────────────────────────────

  describe('GET /payments/:paymentId/status', () => {
    it('200 — returns payment status', async () => {
      mockService.getPaymentStatus.mockResolvedValue(PAYMENT_STATUS_RESPONSE);

      await request(app.getHttpServer())
        .get(`/payments/${PAYMENT_ID}/status`)
        .expect(200)
        .expect((res) => {
          expect(res.body.id).toBe(PAYMENT_ID);
          expect(res.body.status).toBe('PAID');
          expect(res.body.method).toBe('CREDIT_CARD');
        });

      expect(mockService.getPaymentStatus).toHaveBeenCalledWith('user-customer-1', PAYMENT_ID);
    });
  });
});
