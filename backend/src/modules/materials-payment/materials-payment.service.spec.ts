import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { MaterialsPaymentService } from './materials-payment.service';
import { PrismaService } from '../../prisma/prisma.service';
import { MaterialsPaymentStatus } from '@prisma/client';

// ── Mock factories ────────────────────────────────────────────────────────────

const mockMP = (overrides: Partial<any> = {}) => ({
  id: 'mp-1',
  requestId: 'req-1',
  paymentId: 'pay-1',
  estimatedAmount: 350,
  paidAmount: 350,
  usedAmount: 0,
  refundedAmount: 0,
  status: MaterialsPaymentStatus.PAID_AVAILABLE,
  reconciledAt: null,
  ...overrides,
});

const mockRequest = (overrides: Partial<any> = {}) => ({
  id: 'req-1',
  customerId: 'cust-1',
  providerId: 'prov-1',
  hasMaterials: true,
  materialsEstimate: 350,
  ...overrides,
});

const mockUsageLog = (overrides: Partial<any> = {}) => ({
  id: 'log-1',
  materialsPaymentId: 'mp-1',
  amount: 150,
  description: 'أنابيب PVC',
  loggedById: 'prov-1',
  reviewStatus: 'PENDING',
  purchasedAt: new Date(),
  ...overrides,
});

const buildPrisma = () => ({
  materialsPayment: {
    create: jest.fn(),
    findUnique: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
  materialsUsageLog: {
    create: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  materialsReceipt: { create: jest.fn() },
  materialsAdjustmentRequest: {
    create: jest.fn(),
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    update: jest.fn(),
  },
  serviceRequest: { findUnique: jest.fn() },
  user: { findUnique: jest.fn() },
  $transaction: jest.fn(),
});

// ── Test suite ────────────────────────────────────────────────────────────────

describe('MaterialsPaymentService', () => {
  let service: MaterialsPaymentService;
  let prisma: ReturnType<typeof buildPrisma>;
  let emitter: jest.Mocked<EventEmitter2>;

  beforeEach(async () => {
    prisma = buildPrisma();
    emitter = { emit: jest.fn() } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MaterialsPaymentService,
        { provide: PrismaService, useValue: prisma },
        { provide: EventEmitter2, useValue: emitter },
        {
          provide: ConfigService,
          useValue: { getOrThrow: jest.fn().mockReturnValue('test-moyasar-key') },
        },
      ],
    }).compile();

    service = module.get(MaterialsPaymentService);
  });

  // ── create ───────────────────────────────────────────────────────────────
  describe('create', () => {
    it('should create a MaterialsPayment record with PAID_AVAILABLE status and emit event', async () => {
      const mp = mockMP();
      prisma.materialsPayment.create.mockResolvedValue(mp);

      const result = await service.create('req-1', 'pay-1', 350, 350);

      expect(prisma.materialsPayment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: MaterialsPaymentStatus.PAID_AVAILABLE,
            paidAmount: 350,
          }),
        }),
      );
      expect(emitter.emit).toHaveBeenCalledWith(
        'materials.payment.funded',
        expect.objectContaining({ amount: 350 }),
      );
      expect(result.status).toBe(MaterialsPaymentStatus.PAID_AVAILABLE);
    });
  });

  // ── logUsage ─────────────────────────────────────────────────────────────
  describe('logUsage', () => {
    it('should log usage, deduct from budget, and update status to PARTIALLY_USED', async () => {
      const mp = mockMP({ paidAmount: 350, usedAmount: 0 });
      const log = mockUsageLog();
      prisma.materialsPayment.findUnique.mockResolvedValue(mp);
      prisma.serviceRequest.findUnique.mockResolvedValue(mockRequest());
      prisma.$transaction.mockResolvedValue([
        log,
        { ...mp, usedAmount: 150, status: 'PARTIALLY_USED' },
      ]);

      const result = await service.logUsage('prov-1', 'req-1', 150, 'أنابيب', new Date());

      expect(prisma.$transaction).toHaveBeenCalled();
      expect(emitter.emit).toHaveBeenCalledWith(
        'materials.usage.logged',
        expect.objectContaining({ amount: 150 }),
      );
    });

    it('should throw BadRequestException if amount exceeds remaining balance', async () => {
      const mp = mockMP({ paidAmount: 350, usedAmount: 300 }); // only 50 remaining
      prisma.materialsPayment.findUnique.mockResolvedValue(mp);
      prisma.serviceRequest.findUnique.mockResolvedValue(mockRequest());

      await expect(
        service.logUsage('prov-1', 'req-1', 100, 'too much', new Date()),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw ForbiddenException when non-provider tries to log usage', async () => {
      const mp = mockMP();
      prisma.materialsPayment.findUnique.mockResolvedValue(mp);
      prisma.serviceRequest.findUnique.mockResolvedValue(mockRequest({ providerId: 'prov-1' }));

      await expect(service.logUsage('stranger', 'req-1', 50, 'test', new Date())).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('should throw BadRequestException when materials budget is FROZEN', async () => {
      const mp = mockMP({ status: MaterialsPaymentStatus.FROZEN });
      prisma.materialsPayment.findUnique.mockResolvedValue(mp);
      prisma.serviceRequest.findUnique.mockResolvedValue(mockRequest());

      await expect(service.logUsage('prov-1', 'req-1', 50, 'test', new Date())).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  // ── uploadReceipt ────────────────────────────────────────────────────────
  describe('uploadReceipt', () => {
    it('should create a receipt record attached to the usage log', async () => {
      const log = mockUsageLog({ loggedById: 'prov-1' });
      const receipt = { id: 'rc-1', usageLogId: 'log-1', fileUrl: 'https://s3.example.com/r.jpg' };
      prisma.materialsUsageLog.findUnique.mockResolvedValue(log);
      prisma.materialsReceipt.create.mockResolvedValue(receipt);

      await service.uploadReceipt('prov-1', 'log-1', 'https://s3.example.com/r.jpg', 'RECEIPT');
      expect(prisma.materialsReceipt.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ fileUrl: 'https://s3.example.com/r.jpg' }),
        }),
      );
    });

    it('should throw ForbiddenException if non-owner tries to upload receipt', async () => {
      prisma.materialsUsageLog.findUnique.mockResolvedValue(mockUsageLog({ loggedById: 'prov-1' }));
      await expect(service.uploadReceipt('other-prov', 'log-1', 'url', 'PHOTO')).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  // ── reconcile ────────────────────────────────────────────────────────────
  describe('reconcile', () => {
    it('should set REFUNDED_PARTIAL and emit refund event when unused amount > 0', async () => {
      const mp = mockMP({ paidAmount: 350, usedAmount: 220, refundedAmount: 0 });
      prisma.materialsPayment.findUnique.mockResolvedValue(mp);
      prisma.materialsPayment.update.mockResolvedValue({
        ...mp,
        status: MaterialsPaymentStatus.REFUNDED_PARTIAL,
        refundedAmount: 130,
      });

      const result = await service.reconcile('req-1', 'admin-1');

      expect(result.refundTriggered).toBe(true);
      expect(result.refundAmount).toBe(130);
      expect(emitter.emit).toHaveBeenCalledWith(
        'materials.reconciled.refund',
        expect.objectContaining({ refundAmount: 130 }),
      );
    });

    it('should set FULLY_USED when all budget is consumed', async () => {
      const mp = mockMP({ paidAmount: 350, usedAmount: 350, refundedAmount: 0 });
      prisma.materialsPayment.findUnique.mockResolvedValue(mp);
      prisma.materialsPayment.update.mockResolvedValue({
        ...mp,
        status: MaterialsPaymentStatus.FULLY_USED,
      });

      const result = await service.reconcile('req-1', 'admin-1');
      expect(result.refundTriggered).toBe(false);
    });

    it('should throw BadRequestException if already reconciled', async () => {
      prisma.materialsPayment.findUnique.mockResolvedValue(
        mockMP({ status: MaterialsPaymentStatus.REFUNDED_FULL }),
      );
      await expect(service.reconcile('req-1', 'admin-1')).rejects.toThrow(BadRequestException);
    });
  });

  // ── fullRefund ───────────────────────────────────────────────────────────
  describe('fullRefund', () => {
    it('should refund the full paid amount when nothing has been used', async () => {
      const mp = mockMP({ usedAmount: 0, paidAmount: 350 });
      prisma.materialsPayment.findUnique.mockResolvedValue(mp);
      prisma.materialsPayment.update.mockResolvedValue({
        ...mp,
        status: MaterialsPaymentStatus.REFUNDED_FULL,
      });

      await service.fullRefund('req-1');

      expect(prisma.materialsPayment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: MaterialsPaymentStatus.REFUNDED_FULL }),
        }),
      );
      expect(emitter.emit).toHaveBeenCalledWith(
        'materials.refund.full',
        expect.objectContaining({ amount: 350 }),
      );
    });

    it('should throw BadRequestException when some items were already purchased', async () => {
      prisma.materialsPayment.findUnique.mockResolvedValue(mockMP({ usedAmount: 100 }));
      await expect(service.fullRefund('req-1')).rejects.toThrow(BadRequestException);
    });

    it('should return null (no-op) for service-only orders with no materials record', async () => {
      prisma.materialsPayment.findUnique.mockResolvedValue(null);
      const result = await service.fullRefund('req-1');
      expect(result).toBeNull();
    });
  });

  // ── freeze / unfreeze ────────────────────────────────────────────────────
  describe('freeze / unfreeze', () => {
    it('should set status to FROZEN on freeze()', async () => {
      prisma.materialsPayment.updateMany.mockResolvedValue({ count: 1 });
      await service.freeze('req-1');
      expect(prisma.materialsPayment.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: MaterialsPaymentStatus.FROZEN } }),
      );
    });

    it('should restore status to PARTIALLY_USED on unfreeze() when budget is partially used', async () => {
      prisma.materialsPayment.findUnique.mockResolvedValue(
        mockMP({ status: MaterialsPaymentStatus.FROZEN, usedAmount: 100, paidAmount: 350 }),
      );
      prisma.materialsPayment.update.mockResolvedValue(
        mockMP({ status: MaterialsPaymentStatus.PARTIALLY_USED }),
      );

      await service.unfreeze('req-1');

      expect(prisma.materialsPayment.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: MaterialsPaymentStatus.PARTIALLY_USED } }),
      );
    });
  });
});
