import { Test, TestingModule } from '@nestjs/testing';
import { SchedulerService } from './scheduler.service';
import { PrismaService } from '../../prisma/prisma.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { MaterialsPaymentService } from '../materials-payment/materials-payment.service';
import { DisputeStatus, QuoteStatus, JobStatus } from '@prisma/client';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockPrisma = {
  escrow: {
    findMany: jest.fn(),
    updateMany: jest.fn(),
  },
  tenderCommission: {
    updateMany: jest.fn(),
  },
  deviceToken: {
    updateMany: jest.fn(),
  },
  refreshToken: {
    deleteMany: jest.fn(),
  },
  emailVerificationToken: {
    deleteMany: jest.fn(),
  },
  passwordResetToken: {
    deleteMany: jest.fn(),
  },
  review: {
    groupBy: jest.fn(),
  },
  providerProfile: {
    updateMany: jest.fn(),
  },
  materialsPayment: {
    findMany: jest.fn(),
    updateMany: jest.fn(),
  },
  materialsAdjustmentRequest: {
    updateMany: jest.fn(),
  },
  equipmentRental: {
    findMany: jest.fn(),
    updateMany: jest.fn(),
  },
  equipment: {
    updateMany: jest.fn(),
  },
  quote: {
    updateMany: jest.fn(),
  },
  scheduledJobLog: {
    create: jest.fn().mockResolvedValue({}),
  },
  $transaction: jest.fn((ops: any[]) => Promise.all(ops)),
};

const mockEvents = { emit: jest.fn() };

const mockMaterials = {
  reconcile: jest.fn(),
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const makeEscrow = (overrides: any = {}) => ({
  id: 'escrow-1',
  requestId: 'req-1',
  status: 'HELD',
  heldAt: new Date(Date.now() - 50 * 60 * 60 * 1000), // 50h ago
  request: { providerId: 'provider-1', status: 'COMPLETED', completedAt: new Date(Date.now() - 50 * 60 * 60 * 1000), disputes: [] },
  ...overrides,
});

// ── Test suite ────────────────────────────────────────────────────────────────

describe('SchedulerService', () => {
  let service: SchedulerService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SchedulerService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: EventEmitter2, useValue: mockEvents },
        { provide: MaterialsPaymentService, useValue: mockMaterials },
      ],
    }).compile();

    service = module.get<SchedulerService>(SchedulerService);
  });

  // ── autoReleaseEscrow ──────────────────────────────────────────────────────

  describe('autoReleaseEscrow', () => {
    it('releases held escrows past cutoff and emits escrow.released', async () => {
      mockPrisma.escrow.findMany.mockResolvedValue([makeEscrow()]);
      mockPrisma.escrow.updateMany.mockResolvedValue({ count: 1 });

      await service.autoReleaseEscrow();

      expect(mockPrisma.escrow.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 'escrow-1', status: 'HELD' }),
          data: expect.objectContaining({ status: 'RELEASED' }),
        }),
      );
      expect(mockEvents.emit).toHaveBeenCalledWith(
        'escrow.released',
        expect.objectContaining({ requestId: 'req-1', providerId: 'provider-1' }),
      );
    });

    it('does not release when no escrows are found (empty result)', async () => {
      mockPrisma.escrow.findMany.mockResolvedValue([]);

      await service.autoReleaseEscrow();

      expect(mockPrisma.escrow.updateMany).not.toHaveBeenCalled();
      expect(mockEvents.emit).not.toHaveBeenCalled();
    });

    it('skips release when updateMany returns count=0 (already released by another instance)', async () => {
      mockPrisma.escrow.findMany.mockResolvedValue([makeEscrow()]);
      mockPrisma.escrow.updateMany.mockResolvedValue({ count: 0 });

      await service.autoReleaseEscrow();

      // updateMany was called but emitter was NOT called because count === 0
      expect(mockPrisma.escrow.updateMany).toHaveBeenCalled();
      expect(mockEvents.emit).not.toHaveBeenCalled();
    });

    it('writes a scheduledJobLog entry after completion', async () => {
      mockPrisma.escrow.findMany.mockResolvedValue([]);

      await service.autoReleaseEscrow();

      expect(mockPrisma.scheduledJobLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            jobName: 'auto_release_escrow',
            status: JobStatus.SUCCESS,
          }),
        }),
      );
    });
  });

  // ── expireStaleQuotes ─────────────────────────────────────────────────────

  describe('expireStaleQuotes', () => {
    it('marks expired pending quotes as EXPIRED', async () => {
      mockPrisma.quote.updateMany.mockResolvedValue({ count: 3 });

      await service.expireStaleQuotes();

      expect(mockPrisma.quote.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: QuoteStatus.PENDING }),
          data: expect.objectContaining({ status: QuoteStatus.EXPIRED }),
        }),
      );
    });

    it('writes a scheduledJobLog entry after completion', async () => {
      mockPrisma.quote.updateMany.mockResolvedValue({ count: 0 });

      await service.expireStaleQuotes();

      expect(mockPrisma.scheduledJobLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            jobName: 'expire_stale_quotes',
            status: JobStatus.SUCCESS,
          }),
        }),
      );
    });
  });

  // ── logJob (via scheduledJobLog.create) ──────────────────────────────────

  describe('logJob (indirect via expireStaleQuotes)', () => {
    it('calls scheduledJobLog.create with correct jobName, status, message, and duration', async () => {
      mockPrisma.quote.updateMany.mockResolvedValue({ count: 5 });

      await service.expireStaleQuotes();

      expect(mockPrisma.scheduledJobLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            jobName: expect.any(String),
            status: expect.any(String),
            message: expect.any(String),
            duration: expect.any(Number),
          }),
        }),
      );
    });
  });
});
