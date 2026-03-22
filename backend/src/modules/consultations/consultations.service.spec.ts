import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConsultationsService } from './consultations.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ConsultationStatus, UserRole } from '@prisma/client';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const makeConsult = (overrides: any = {}) => ({
  id: 'consult-1',
  customerId: 'customer-1',
  providerId: null,
  serviceId: 'service-1',
  status: ConsultationStatus.PENDING,
  mode: 'CHAT',
  topic: 'مشكلة كهرباء',
  description: 'الكهرباء انقطعت في غرفة واحدة',
  rating: null,
  notes: null,
  pricePerHour: null,
  totalAmount: null,
  startedAt: null,
  completedAt: null,
  scheduledAt: null,
  durationMinutes: 60,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockPrisma = {
  consultation: {
    create: jest.fn(),
    findUnique: jest.fn(),
    findUniqueOrThrow: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
};

const mockEvents = { emit: jest.fn() };

// ── Test suite ────────────────────────────────────────────────────────────────

describe('ConsultationsService', () => {
  let service: ConsultationsService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConsultationsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: EventEmitter2, useValue: mockEvents },
      ],
    }).compile();

    service = module.get<ConsultationsService>(ConsultationsService);
  });

  // ── create ─────────────────────────────────────────────────────────────────

  describe('create', () => {
    it('creates consultation and emits consultation.created', async () => {
      const consult = makeConsult();
      mockPrisma.consultation.create.mockResolvedValue(consult);

      const result = await service.create('customer-1', {
        serviceId: 'service-1',
        topic: 'مشكلة كهرباء',
        description: 'وصف',
        mode: 'CHAT' as any,
        durationMinutes: 60,
      });

      expect(result.id).toBe('consult-1');
      expect(mockEvents.emit).toHaveBeenCalledWith(
        'consultation.created',
        expect.objectContaining({ consultationId: 'consult-1', customerId: 'customer-1' }),
      );
    });
  });

  // ── findById ───────────────────────────────────────────────────────────────

  describe('findById', () => {
    it('returns consultation when requester is the customer', async () => {
      mockPrisma.consultation.findUnique.mockResolvedValue(makeConsult());
      const result = await service.findById('consult-1', 'customer-1', UserRole.CUSTOMER);
      expect(result.id).toBe('consult-1');
    });

    it('returns consultation for ADMIN regardless of party', async () => {
      mockPrisma.consultation.findUnique.mockResolvedValue(makeConsult());
      const result = await service.findById('consult-1', 'admin-99', UserRole.ADMIN);
      expect(result.id).toBe('consult-1');
    });

    it('throws NotFoundException when consultation does not exist', async () => {
      mockPrisma.consultation.findUnique.mockResolvedValue(null);
      await expect(service.findById('missing', 'customer-1', UserRole.CUSTOMER)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws ForbiddenException for unrelated customer', async () => {
      mockPrisma.consultation.findUnique.mockResolvedValue(
        makeConsult({ customerId: 'someone-else' }),
      );
      await expect(service.findById('consult-1', 'customer-1', UserRole.CUSTOMER)).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  // ── accept ─────────────────────────────────────────────────────────────────

  describe('accept', () => {
    it('sets status to ACCEPTED and emits consultation.accepted', async () => {
      mockPrisma.consultation.findUnique.mockResolvedValue(makeConsult());
      mockPrisma.consultation.update.mockResolvedValue(
        makeConsult({ status: ConsultationStatus.ACCEPTED, providerId: 'provider-1' }),
      );

      const result = await service.accept('provider-1', 'consult-1');

      expect(result.status).toBe(ConsultationStatus.ACCEPTED);
      expect(mockEvents.emit).toHaveBeenCalledWith(
        'consultation.accepted',
        expect.objectContaining({ consultationId: 'consult-1', providerId: 'provider-1' }),
      );
    });

    it('throws BadRequestException if already ACCEPTED', async () => {
      mockPrisma.consultation.findUnique.mockResolvedValue(
        makeConsult({ status: ConsultationStatus.ACCEPTED, providerId: 'provider-1' }),
      );
      await expect(service.accept('provider-1', 'consult-1')).rejects.toThrow(BadRequestException);
    });

    it('throws NotFoundException for unknown consultation', async () => {
      mockPrisma.consultation.findUnique.mockResolvedValue(null);
      await expect(service.accept('provider-1', 'missing')).rejects.toThrow(NotFoundException);
    });
  });

  // ── reject ─────────────────────────────────────────────────────────────────

  describe('reject', () => {
    it('sets status to REJECTED', async () => {
      mockPrisma.consultation.findUnique.mockResolvedValue(makeConsult());
      mockPrisma.consultation.update.mockResolvedValue(
        makeConsult({ status: ConsultationStatus.REJECTED }),
      );

      const result = await service.reject('provider-1', 'consult-1');
      expect(result.status).toBe(ConsultationStatus.REJECTED);
    });

    it('throws BadRequestException if already IN_SESSION', async () => {
      mockPrisma.consultation.findUnique.mockResolvedValue(
        makeConsult({ status: ConsultationStatus.IN_SESSION, providerId: 'provider-1' }),
      );
      await expect(service.reject('provider-1', 'consult-1')).rejects.toThrow(BadRequestException);
    });
  });

  // ── startSession ───────────────────────────────────────────────────────────

  describe('startSession', () => {
    it('sets status to IN_SESSION and emits consultation.started', async () => {
      mockPrisma.consultation.findUnique.mockResolvedValue(
        makeConsult({ status: ConsultationStatus.ACCEPTED, providerId: 'provider-1' }),
      );
      mockPrisma.consultation.update.mockResolvedValue(
        makeConsult({ status: ConsultationStatus.IN_SESSION, providerId: 'provider-1' }),
      );

      await service.startSession('provider-1', 'consult-1');

      expect(mockEvents.emit).toHaveBeenCalledWith(
        'consultation.started',
        expect.objectContaining({ consultationId: 'consult-1', providerId: 'provider-1' }),
      );
    });

    it('throws ForbiddenException for wrong provider', async () => {
      mockPrisma.consultation.findUnique.mockResolvedValue(
        makeConsult({ status: ConsultationStatus.ACCEPTED, providerId: 'correct-provider' }),
      );
      await expect(service.startSession('wrong-provider', 'consult-1')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('throws BadRequestException if still PENDING', async () => {
      mockPrisma.consultation.findUnique.mockResolvedValue(
        makeConsult({ status: ConsultationStatus.PENDING, providerId: 'provider-1' }),
      );
      await expect(service.startSession('provider-1', 'consult-1')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  // ── complete ───────────────────────────────────────────────────────────────

  describe('complete', () => {
    it('sets status to COMPLETED and emits consultation.completed', async () => {
      const completed = makeConsult({ status: ConsultationStatus.COMPLETED, providerId: 'provider-1' });
      mockPrisma.consultation.findUnique.mockResolvedValue(
        makeConsult({ status: ConsultationStatus.IN_SESSION, providerId: 'provider-1' }),
      );
      mockPrisma.consultation.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.consultation.findUniqueOrThrow.mockResolvedValue(completed);

      await service.complete('provider-1', 'consult-1', 'ملاحظات المزود');

      expect(mockPrisma.consultation.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 'consult-1', status: ConsultationStatus.IN_SESSION }),
          data: expect.objectContaining({ status: ConsultationStatus.COMPLETED }),
        }),
      );
      expect(mockEvents.emit).toHaveBeenCalledWith(
        'consultation.completed',
        expect.objectContaining({ consultationId: 'consult-1', providerId: 'provider-1' }),
      );
    });

    it('calculates totalAmount from pricePerHour when startedAt is set', async () => {
      const startedAt = new Date(Date.now() - 30 * 60 * 1000); // 30 min ago
      mockPrisma.consultation.findUnique.mockResolvedValue(
        makeConsult({
          status: ConsultationStatus.IN_SESSION,
          providerId: 'provider-1',
          startedAt,
          pricePerHour: 200,
        }),
      );
      mockPrisma.consultation.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.consultation.findUniqueOrThrow.mockResolvedValue(
        makeConsult({ status: ConsultationStatus.COMPLETED }),
      );

      await service.complete('provider-1', 'consult-1');

      // 30 min = 0.5 hrs → 200 * 0.5 = 100 SAR (above the 0.25 min-charge floor)
      const updateCall = mockPrisma.consultation.updateMany.mock.calls[0][0];
      expect(Number(updateCall.data.totalAmount)).toBeGreaterThan(0);
    });

    it('enforces minimum 15-minute charge', async () => {
      const startedAt = new Date(Date.now() - 5 * 60 * 1000); // only 5 min ago
      mockPrisma.consultation.findUnique.mockResolvedValue(
        makeConsult({
          status: ConsultationStatus.IN_SESSION,
          providerId: 'provider-1',
          startedAt,
          pricePerHour: 200,
        }),
      );
      mockPrisma.consultation.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.consultation.findUniqueOrThrow.mockResolvedValue(
        makeConsult({ status: ConsultationStatus.COMPLETED }),
      );

      await service.complete('provider-1', 'consult-1');

      // min charge = 0.25 * 200 = 50 SAR
      const updateCall = mockPrisma.consultation.updateMany.mock.calls[0][0];
      expect(Number(updateCall.data.totalAmount)).toBeCloseTo(50, 0);
    });
  });

  // ── cancel ─────────────────────────────────────────────────────────────────

  describe('cancel', () => {
    it('cancels PENDING consultation for the owner customer', async () => {
      mockPrisma.consultation.findUnique.mockResolvedValue(makeConsult());
      mockPrisma.consultation.update.mockResolvedValue(
        makeConsult({ status: ConsultationStatus.CANCELLED }),
      );

      const result = await service.cancel('customer-1', 'consult-1');
      expect(result.status).toBe(ConsultationStatus.CANCELLED);
    });

    it('cancels ACCEPTED consultation', async () => {
      mockPrisma.consultation.findUnique.mockResolvedValue(
        makeConsult({ status: ConsultationStatus.ACCEPTED }),
      );
      mockPrisma.consultation.update.mockResolvedValue(
        makeConsult({ status: ConsultationStatus.CANCELLED }),
      );

      await expect(service.cancel('customer-1', 'consult-1')).resolves.toBeDefined();
    });

    it('throws ForbiddenException for wrong customer', async () => {
      mockPrisma.consultation.findUnique.mockResolvedValue(
        makeConsult({ customerId: 'someone-else' }),
      );
      await expect(service.cancel('customer-1', 'consult-1')).rejects.toThrow(ForbiddenException);
    });

    it('throws BadRequestException when consultation is IN_SESSION', async () => {
      mockPrisma.consultation.findUnique.mockResolvedValue(
        makeConsult({ status: ConsultationStatus.IN_SESSION }),
      );
      await expect(service.cancel('customer-1', 'consult-1')).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when consultation is already COMPLETED', async () => {
      mockPrisma.consultation.findUnique.mockResolvedValue(
        makeConsult({ status: ConsultationStatus.COMPLETED }),
      );
      await expect(service.cancel('customer-1', 'consult-1')).rejects.toThrow(BadRequestException);
    });
  });

  // ── rate ───────────────────────────────────────────────────────────────────

  describe('rate', () => {
    it('saves rating and emits consultation.rated', async () => {
      mockPrisma.consultation.findUnique.mockResolvedValue(
        makeConsult({ status: ConsultationStatus.COMPLETED, providerId: 'provider-1' }),
      );
      mockPrisma.consultation.update.mockResolvedValue(
        makeConsult({ status: ConsultationStatus.COMPLETED, rating: 5 }),
      );

      await service.rate('customer-1', 'consult-1', { rating: 5, notes: 'ممتاز' });

      expect(mockPrisma.consultation.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ rating: 5 }) }),
      );
      expect(mockEvents.emit).toHaveBeenCalledWith(
        'consultation.rated',
        expect.objectContaining({ consultationId: 'consult-1', rating: 5 }),
      );
    });

    it('throws BadRequestException if consultation is not COMPLETED', async () => {
      mockPrisma.consultation.findUnique.mockResolvedValue(
        makeConsult({ status: ConsultationStatus.IN_SESSION }),
      );
      await expect(service.rate('customer-1', 'consult-1', { rating: 4 })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('throws BadRequestException if already rated', async () => {
      mockPrisma.consultation.findUnique.mockResolvedValue(
        makeConsult({ status: ConsultationStatus.COMPLETED, rating: 4 }),
      );
      await expect(service.rate('customer-1', 'consult-1', { rating: 5 })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('throws ForbiddenException for wrong customer', async () => {
      mockPrisma.consultation.findUnique.mockResolvedValue(
        makeConsult({ status: ConsultationStatus.COMPLETED, customerId: 'someone-else' }),
      );
      await expect(service.rate('customer-1', 'consult-1', { rating: 5 })).rejects.toThrow(
        ForbiddenException,
      );
    });
  });
});
