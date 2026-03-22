import { Test, TestingModule } from '@nestjs/testing';
import { RequestsService } from './requests.service';
import { PrismaService } from '../../prisma/prisma.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';

const mockPrisma = {
  serviceRequest: {
    create: jest.fn(),
    findMany: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
    count: jest.fn(),
  },
  providerProfile: {
    findUnique: jest.fn(),
  },
  quote: {
    create: jest.fn(),
    findFirst: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
  $transaction: jest.fn(),
};

// Default approved provider profile for submitQuote tests
const approvedProvider = { verificationStatus: 'APPROVED', user: { suspended: false } };

const mockEvents = { emit: jest.fn() };

describe('RequestsService', () => {
  let service: RequestsService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RequestsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: EventEmitter2, useValue: mockEvents },
      ],
    }).compile();
    service = module.get<RequestsService>(RequestsService);
  });

  // ── create ─────────────────────────────────────────────────────────────────
  describe('create', () => {
    it('creates a request and emits request.created', async () => {
      const req = { id: 'req-1', customerId: 'cust-1' };
      mockPrisma.serviceRequest.create.mockResolvedValue(req);

      const result = await service.create('cust-1', {
        serviceId: 'svc-1',
        city: 'الرياض',
        description: 'test',
      } as any);

      expect(mockPrisma.serviceRequest.create).toHaveBeenCalledTimes(1);
      expect(mockEvents.emit).toHaveBeenCalledWith(
        'request.created',
        expect.objectContaining({ requestId: 'req-1' }),
      );
      expect(result.id).toBe('req-1');
    });
  });

  // ── cancel ─────────────────────────────────────────────────────────────────
  describe('cancel', () => {
    it('throws NotFoundException when request not found', async () => {
      mockPrisma.serviceRequest.findUnique.mockResolvedValue(null);
      await expect(service.cancel('req-bad', 'cust-1')).rejects.toThrow(NotFoundException);
    });

    it('throws ForbiddenException when not the customer', async () => {
      mockPrisma.serviceRequest.findUnique.mockResolvedValue({
        customerId: 'other',
        status: 'PENDING',
      });
      await expect(service.cancel('req-1', 'cust-1')).rejects.toThrow(ForbiddenException);
    });

    it('throws BadRequestException when status is IN_PROGRESS', async () => {
      mockPrisma.serviceRequest.findUnique.mockResolvedValue({
        customerId: 'cust-1',
        status: 'IN_PROGRESS',
      });
      await expect(service.cancel('req-1', 'cust-1')).rejects.toThrow(BadRequestException);
    });

    it('cancels PENDING request successfully', async () => {
      mockPrisma.serviceRequest.findUnique.mockResolvedValue({
        customerId: 'cust-1',
        status: 'PENDING',
      });
      mockPrisma.serviceRequest.update.mockResolvedValue({ id: 'req-1', status: 'CANCELLED' });

      const result = await service.cancel('req-1', 'cust-1');
      expect(result.status).toBe('CANCELLED');
    });
  });

  // ── submitQuote ────────────────────────────────────────────────────────────
  describe('submitQuote', () => {
    const dto = { amount: 500, includesMaterials: false, message: 'ready' };

    it('throws NotFoundException for unknown request', async () => {
      mockPrisma.providerProfile.findUnique.mockResolvedValue(approvedProvider);
      mockPrisma.serviceRequest.findUnique.mockResolvedValue(null);
      await expect(service.submitQuote('prov-1', 'req-bad', dto as any)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws BadRequestException when request is not PENDING/QUOTED', async () => {
      mockPrisma.providerProfile.findUnique.mockResolvedValue(approvedProvider);
      mockPrisma.serviceRequest.findUnique.mockResolvedValue({
        status: 'IN_PROGRESS',
        customerId: 'cust-1',
      });
      await expect(service.submitQuote('prov-1', 'req-1', dto as any)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('throws ConflictException when provider already quoted', async () => {
      mockPrisma.providerProfile.findUnique.mockResolvedValue(approvedProvider);
      mockPrisma.serviceRequest.findUnique.mockResolvedValue({
        status: 'PENDING',
        customerId: 'cust-1',
      });
      mockPrisma.quote.findFirst.mockResolvedValue({ id: 'q-1' });
      await expect(service.submitQuote('prov-1', 'req-1', dto as any)).rejects.toThrow(
        ConflictException,
      );
    });

    it('creates quote in transaction and emits event', async () => {
      mockPrisma.providerProfile.findUnique.mockResolvedValue(approvedProvider);
      mockPrisma.serviceRequest.findUnique.mockResolvedValue({
        status: 'PENDING',
        customerId: 'cust-1',
      });
      mockPrisma.quote.findFirst.mockResolvedValue(null);
      const quote = { id: 'q-1', requestId: 'req-1', providerId: 'prov-1', amount: 500 };
      mockPrisma.$transaction.mockResolvedValue([quote]);

      const result = await service.submitQuote('prov-1', 'req-1', dto as any);
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
      expect(mockEvents.emit).toHaveBeenCalledWith(
        'quote.submitted',
        expect.objectContaining({ providerId: 'prov-1' }),
      );
      expect(result.id).toBe('q-1');
    });
  });

  // ── acceptQuote ────────────────────────────────────────────────────────────
  describe('acceptQuote', () => {
    it('throws ForbiddenException for wrong customer', async () => {
      mockPrisma.serviceRequest.findUnique.mockResolvedValue({
        customerId: 'other',
        status: 'QUOTED',
        quotes: [],
      });
      await expect(service.acceptQuote('cust-1', 'req-1', 'q-1')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('throws NotFoundException when quote not in request', async () => {
      mockPrisma.serviceRequest.findUnique.mockResolvedValue({
        customerId: 'cust-1',
        status: 'QUOTED',
        quotes: [{ id: 'q-other' }],
      });
      await expect(service.acceptQuote('cust-1', 'req-1', 'q-1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('accepts quote atomically and emits event', async () => {
      const quote = { id: 'q-1', providerId: 'prov-1', amount: 500 };
      mockPrisma.serviceRequest.findUnique.mockResolvedValue({
        customerId: 'cust-1',
        status: 'QUOTED',
        quotes: [quote],
      });
      mockPrisma.$transaction.mockResolvedValue([]);

      const result = await service.acceptQuote('cust-1', 'req-1', 'q-1');
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
      expect(mockEvents.emit).toHaveBeenCalledWith(
        'quote.accepted',
        expect.objectContaining({ quoteId: 'q-1' }),
      );
      expect(result.providerId).toBe('prov-1');
    });
  });
});
