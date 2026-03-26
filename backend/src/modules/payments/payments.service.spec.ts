import { Test, TestingModule } from '@nestjs/testing';
import { PaymentsService } from './payments.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { MaterialsPaymentService } from '../materials-payment/materials-payment.service';
import axios from 'axios';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

// ── Mock factories ───────────────────────────────────────────────────────────

const mockPrisma = {
  serviceRequest: {
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  payment: {
    create: jest.fn(),
    update: jest.fn(),
    findUnique: jest.fn(),
  },
  escrow: {
    create: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  providerProfile: {
    update: jest.fn(),
  },
  $transaction: jest.fn(),
};

const mockConfig = {
  get: jest.fn((key: string, def?: any) => def),
  getOrThrow: jest.fn().mockReturnValue('sk_test_key'),
};

const mockEvents = { emit: jest.fn() };

const mockMaterialsPayment = {
  create: jest.fn(),
  fullRefund: jest.fn(),
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PaymentsService', () => {
  let service: PaymentsService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: ConfigService, useValue: mockConfig },
        { provide: EventEmitter2, useValue: mockEvents },
        { provide: MaterialsPaymentService, useValue: mockMaterialsPayment },
      ],
    }).compile();

    service = module.get<PaymentsService>(PaymentsService);
  });

  // ── initiatePayment ────────────────────────────────────────────────────────
  describe('initiatePayment', () => {
    const customerId = 'cust-1';
    const requestId = 'req-1';

    it('throws NotFoundException when request not found', async () => {
      mockPrisma.serviceRequest.findUnique.mockResolvedValue(null);
      await expect(service.initiatePayment(customerId, requestId, 'MADA')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws ForbiddenException when request belongs to different customer', async () => {
      mockPrisma.serviceRequest.findUnique.mockResolvedValue({
        customerId: 'other-cust',
        status: 'ACCEPTED',
        quotes: [{ amount: 500, status: 'ACCEPTED' }],
      });
      await expect(service.initiatePayment(customerId, requestId, 'MADA')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('throws BadRequestException when status is not ACCEPTED', async () => {
      mockPrisma.serviceRequest.findUnique.mockResolvedValue({
        customerId,
        status: 'PENDING',
        quotes: [],
      });
      await expect(service.initiatePayment(customerId, requestId, 'MADA')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('throws BadRequestException when no accepted quote found', async () => {
      mockPrisma.serviceRequest.findUnique.mockResolvedValue({
        customerId,
        status: 'ACCEPTED',
        quotes: [],
      });
      await expect(service.initiatePayment(customerId, requestId, 'MADA')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('creates payment and calls Moyasar, returns checkout URL', async () => {
      mockPrisma.serviceRequest.findUnique.mockResolvedValue({
        customerId,
        status: 'ACCEPTED',
        quotes: [{ amount: 500, status: 'ACCEPTED' }],
      });
      const paymentRow = { id: 'pay-1', amount: 500 };
      mockPrisma.$transaction.mockImplementation(async (cb: any) => {
        const tx = {
          payment: {
            findFirst: jest.fn().mockResolvedValue(null),
            create: jest.fn().mockResolvedValue(paymentRow),
          },
        };
        return cb(tx);
      });
      mockPrisma.payment.update.mockResolvedValue({});
      mockedAxios.post.mockResolvedValue({
        data: { id: 'moyasar-ref-1', source: { url: 'https://checkout.moyasar.com/pay/xxx' } },
      });

      const result = await service.initiatePayment(customerId, requestId, 'MADA');

      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1); // payment created inside tx
      expect(mockedAxios.post).toHaveBeenCalledTimes(1);
      expect(result).toHaveProperty('paymentId', 'pay-1');
      expect(result).toHaveProperty('checkoutUrl');
    });

    it('marks payment FAILED when Moyasar call throws', async () => {
      mockPrisma.serviceRequest.findUnique.mockResolvedValue({
        customerId,
        status: 'ACCEPTED',
        quotes: [{ amount: 500, status: 'ACCEPTED' }],
      });
      mockPrisma.$transaction.mockImplementation(async (cb: any) => {
        const tx = {
          payment: {
            findFirst: jest.fn().mockResolvedValue(null),
            create: jest.fn().mockResolvedValue({ id: 'pay-1', amount: 500 }),
          },
        };
        return cb(tx);
      });
      mockPrisma.payment.update.mockResolvedValue({});
      mockedAxios.post.mockRejectedValue(new Error('network error'));

      await expect(service.initiatePayment(customerId, requestId, 'MADA')).rejects.toThrow(
        BadRequestException,
      );
      expect(mockPrisma.payment.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: 'FAILED' } }),
      );
    });
  });

  // ── releaseEscrow ──────────────────────────────────────────────────────────
  describe('releaseEscrow', () => {
    const customerId = 'cust-1';
    const requestId = 'req-1';

    it('throws NotFoundException when request not found', async () => {
      mockPrisma.serviceRequest.findUnique.mockResolvedValue(null);
      await expect(service.releaseEscrow(customerId, requestId)).rejects.toThrow(NotFoundException);
    });

    it('throws ForbiddenException for wrong customer', async () => {
      mockPrisma.serviceRequest.findUnique.mockResolvedValue({
        customerId: 'other',
        status: 'IN_PROGRESS',
      });
      await expect(service.releaseEscrow(customerId, requestId)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('throws BadRequestException when not IN_PROGRESS', async () => {
      mockPrisma.serviceRequest.findUnique.mockResolvedValue({ customerId, status: 'ACCEPTED' });
      await expect(service.releaseEscrow(customerId, requestId)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('releases escrow atomically and emits event', async () => {
      mockPrisma.serviceRequest.findUnique.mockResolvedValue({
        customerId,
        status: 'IN_PROGRESS',
        providerId: 'prov-1',
      });
      mockPrisma.escrow.findUnique.mockResolvedValue({ id: 'esc-1', status: 'HELD' });
      mockPrisma.$transaction.mockResolvedValue([]);

      const result = await service.releaseEscrow(customerId, requestId);

      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
      expect(mockEvents.emit).toHaveBeenCalledWith(
        'escrow.released',
        expect.objectContaining({ requestId }),
      );
      expect(result.message).toBeTruthy();
    });
  });

  // ── getPaymentStatus ───────────────────────────────────────────────────────
  describe('getPaymentStatus', () => {
    it('throws NotFoundException for unknown payment', async () => {
      mockPrisma.payment.findUnique.mockResolvedValue(null);
      await expect(service.getPaymentStatus('cust-1', 'bad-id')).rejects.toThrow(NotFoundException);
    });

    it('throws ForbiddenException for wrong owner', async () => {
      mockPrisma.payment.findUnique.mockResolvedValue({
        id: 'pay-1',
        request: { customerId: 'other' },
      });
      await expect(service.getPaymentStatus('cust-1', 'pay-1')).rejects.toThrow(ForbiddenException);
    });
  });
});
