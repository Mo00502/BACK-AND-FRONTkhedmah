import { Test, TestingModule } from '@nestjs/testing';
import { AdminService } from './admin.service';
import { PrismaService } from '../../prisma/prisma.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';

const mockPrisma = {
  providerProfile: {
    findUnique: jest.fn(),
    update: jest.fn(),
    count: jest.fn(),
    findMany: jest.fn(),
  },
  user: {
    count: jest.fn(),
    update: jest.fn(),
  },
  serviceRequest: {
    count: jest.fn(),
    findMany: jest.fn(),
  },
  escrow: {
    aggregate: jest.fn(),
  },
  dispute: {
    findUnique: jest.fn(),
    count: jest.fn(),
    findMany: jest.fn(),
  },
  payment: {
    count: jest.fn(),
  },
  scheduledJobLog: {
    findMany: jest.fn(),
  },
  $transaction: jest.fn(),
};

const mockEvents = { emit: jest.fn() };

describe('AdminService', () => {
  let service: AdminService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: EventEmitter2, useValue: mockEvents },
      ],
    }).compile();
    service = module.get<AdminService>(AdminService);
  });

  // ── approveProvider ──────────────────────────────────────────────────────
  describe('approveProvider', () => {
    it('approves a PENDING_REVIEW provider and emits events', async () => {
      const profile = {
        id: 'prov-1',
        userId: 'user-1',
        verificationStatus: 'PENDING_REVIEW',
        user: { email: 'prov@example.com' },
      };
      const updated = { ...profile, verificationStatus: 'APPROVED', verified: true };
      mockPrisma.providerProfile.findUnique.mockResolvedValue(profile);
      mockPrisma.providerProfile.update.mockResolvedValue(updated);

      const result = await service.approveProvider('prov-1');

      expect(mockPrisma.providerProfile.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'prov-1' },
          data: expect.objectContaining({ verificationStatus: 'APPROVED', verified: true }),
        }),
      );
      expect(mockEvents.emit).toHaveBeenCalledWith(
        'provider.approved',
        expect.objectContaining({ userId: 'user-1', email: 'prov@example.com' }),
      );
      expect(mockEvents.emit).toHaveBeenCalledWith(
        'audit.log',
        expect.objectContaining({ action: 'APPROVE', entityType: 'ProviderProfile', entityId: 'prov-1' }),
      );
      expect(result.verificationStatus).toBe('APPROVED');
    });

    it('approves a provider in UNDER_REVIEW status', async () => {
      const profile = {
        id: 'prov-2',
        userId: 'user-2',
        verificationStatus: 'UNDER_REVIEW',
        user: { email: 'prov2@example.com' },
      };
      mockPrisma.providerProfile.findUnique.mockResolvedValue(profile);
      mockPrisma.providerProfile.update.mockResolvedValue({ ...profile, verificationStatus: 'APPROVED' });

      await service.approveProvider('prov-2');

      expect(mockPrisma.providerProfile.update).toHaveBeenCalledTimes(1);
    });

    it('throws NotFoundException when provider does not exist', async () => {
      mockPrisma.providerProfile.findUnique.mockResolvedValue(null);
      await expect(service.approveProvider('non-existent')).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException when provider is already APPROVED', async () => {
      mockPrisma.providerProfile.findUnique.mockResolvedValue({
        id: 'prov-3',
        userId: 'user-3',
        verificationStatus: 'APPROVED',
        user: { email: 'prov3@example.com' },
      });
      await expect(service.approveProvider('prov-3')).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when provider is REJECTED', async () => {
      mockPrisma.providerProfile.findUnique.mockResolvedValue({
        id: 'prov-4',
        userId: 'user-4',
        verificationStatus: 'REJECTED',
        user: { email: 'prov4@example.com' },
      });
      await expect(service.approveProvider('prov-4')).rejects.toThrow(BadRequestException);
    });
  });

  // ── rejectProvider ───────────────────────────────────────────────────────
  describe('rejectProvider', () => {
    it('rejects a provider and emits provider.rejected and audit.log', async () => {
      const profile = {
        id: 'prov-1',
        userId: 'user-1',
        verificationStatus: 'PENDING_REVIEW',
        user: { email: 'prov@example.com' },
      };
      const updated = { ...profile, verificationStatus: 'REJECTED', verified: false };
      mockPrisma.providerProfile.findUnique.mockResolvedValue(profile);
      mockPrisma.providerProfile.update.mockResolvedValue(updated);

      const result = await service.rejectProvider('prov-1', 'Documents incomplete');

      expect(mockPrisma.providerProfile.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            verificationStatus: 'REJECTED',
            verified: false,
            rejectionReason: 'Documents incomplete',
          }),
        }),
      );
      expect(mockEvents.emit).toHaveBeenCalledWith(
        'provider.rejected',
        expect.objectContaining({ userId: 'user-1', email: 'prov@example.com', reason: 'Documents incomplete' }),
      );
      expect(mockEvents.emit).toHaveBeenCalledWith(
        'audit.log',
        expect.objectContaining({ action: 'REJECT', entityType: 'ProviderProfile', entityId: 'prov-1' }),
      );
      expect(result.verificationStatus).toBe('REJECTED');
    });

    it('throws NotFoundException when provider does not exist', async () => {
      mockPrisma.providerProfile.findUnique.mockResolvedValue(null);
      await expect(service.rejectProvider('non-existent', 'reason')).rejects.toThrow(NotFoundException);
    });
  });

  // ── suspendUser ──────────────────────────────────────────────────────────
  describe('suspendUser', () => {
    it('suspends a user and emits admin.user_suspended and audit.log', async () => {
      const updatedUser = { id: 'user-1', suspended: true, suspendedReason: 'Fraudulent activity' };
      mockPrisma.user.update.mockResolvedValue(updatedUser);

      const result = await service.suspendUser('user-1', 'Fraudulent activity', 'admin-1');

      expect(mockPrisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'user-1' },
          data: expect.objectContaining({
            suspended: true,
            suspendedReason: 'Fraudulent activity',
          }),
        }),
      );
      expect(mockEvents.emit).toHaveBeenCalledWith(
        'admin.user_suspended',
        expect.objectContaining({ targetUserId: 'user-1', adminId: 'admin-1', reason: 'Fraudulent activity' }),
      );
      expect(mockEvents.emit).toHaveBeenCalledWith(
        'audit.log',
        expect.objectContaining({ userId: 'admin-1', action: 'SUSPEND', entityType: 'User', entityId: 'user-1' }),
      );
      expect(result.suspended).toBe(true);
    });

    it('uses "system" as adminId when no adminId is provided', async () => {
      mockPrisma.user.update.mockResolvedValue({ id: 'user-2', suspended: true });

      await service.suspendUser('user-2', 'spam');

      expect(mockEvents.emit).toHaveBeenCalledWith(
        'admin.user_suspended',
        expect.objectContaining({ adminId: 'system' }),
      );
    });
  });

  // ── resolveDispute ───────────────────────────────────────────────────────
  describe('resolveDispute', () => {
    const makeDispute = (escrowStatus: string = 'HELD', resolution?: string) => ({
      id: 'dispute-1',
      requestId: 'req-1',
      reporterId: 'reporter-1',
      againstId: 'against-1',
      resolution: resolution ?? null,
      request: {
        providerId: 'provider-1',
        escrow: {
          id: 'escrow-1',
          status: escrowStatus,
          amount: new Decimal('1000.00'),
          platformFee: new Decimal('150.00'),
          paymentId: 'pay-1',
        },
      },
    });

    it('throws NotFoundException when dispute does not exist', async () => {
      mockPrisma.dispute.findUnique.mockResolvedValue(null);
      await expect(service.resolveDispute('non-existent', 'admin-1', 'RELEASE', 'notes')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws ForbiddenException when admin is a party to the dispute', async () => {
      const dispute = makeDispute();
      dispute.reporterId = 'admin-1'; // admin is the reporter
      mockPrisma.dispute.findUnique.mockResolvedValue(dispute);

      await expect(service.resolveDispute('dispute-1', 'admin-1', 'RELEASE', 'notes')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('RELEASE resolution: emits escrow.released after transaction', async () => {
      mockPrisma.dispute.findUnique.mockResolvedValue(makeDispute('HELD'));
      mockPrisma.$transaction.mockImplementation(async (fn: any) => {
        await fn({
          dispute: { update: jest.fn().mockResolvedValue({}) },
          escrow: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
          serviceRequest: { update: jest.fn().mockResolvedValue({}) },
        });
      });

      const result = await service.resolveDispute('dispute-1', 'admin-1', 'RELEASE', 'provider was correct');

      expect(mockEvents.emit).toHaveBeenCalledWith(
        'escrow.released',
        expect.objectContaining({ requestId: 'req-1', providerId: 'provider-1', source: 'dispute_resolution' }),
      );
      expect(mockEvents.emit).toHaveBeenCalledWith(
        'dispute.resolved',
        expect.objectContaining({ disputeId: 'dispute-1', resolution: 'RELEASE' }),
      );
      expect(result).toEqual({ message: 'Dispute resolved: RELEASE' });
    });

    it('REFUND resolution: emits dispute.refund_ordered after transaction', async () => {
      mockPrisma.dispute.findUnique.mockResolvedValue(makeDispute('HELD'));
      mockPrisma.$transaction.mockImplementation(async (fn: any) => {
        await fn({
          dispute: { update: jest.fn().mockResolvedValue({}) },
          escrow: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
          serviceRequest: { update: jest.fn().mockResolvedValue({}) },
        });
      });

      await service.resolveDispute('dispute-1', 'admin-1', 'REFUND', 'customer was correct');

      expect(mockEvents.emit).toHaveBeenCalledWith(
        'dispute.refund_ordered',
        expect.objectContaining({ disputeId: 'dispute-1', requestId: 'req-1', paymentId: 'pay-1', adminId: 'admin-1' }),
      );
      expect(mockEvents.emit).not.toHaveBeenCalledWith('escrow.released', expect.anything());
    });

    it('SPLIT resolution: emits both dispute.split_release and dispute.split_refund', async () => {
      mockPrisma.dispute.findUnique.mockResolvedValue(makeDispute('HELD'));
      mockPrisma.$transaction.mockImplementation(async (fn: any) => {
        await fn({
          dispute: { update: jest.fn().mockResolvedValue({}) },
          escrow: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
          serviceRequest: { update: jest.fn().mockResolvedValue({}) },
        });
      });

      await service.resolveDispute('dispute-1', 'admin-1', 'SPLIT', 'split evenly');

      expect(mockEvents.emit).toHaveBeenCalledWith(
        'dispute.split_release',
        expect.objectContaining({
          requestId: 'req-1',
          providerId: 'provider-1',
          providerAmount: 425, // (1000/2) - (150/2) = 500 - 75 = 425
          escrowId: 'escrow-1',
        }),
      );
      expect(mockEvents.emit).toHaveBeenCalledWith(
        'dispute.split_refund',
        expect.objectContaining({
          disputeId: 'dispute-1',
          refundAmount: 500, // 1000/2
          adminId: 'admin-1',
        }),
      );
    });

    it('SPLIT resolution: throws BadRequestException when platform fee >= half the escrow', async () => {
      const disputeHighFee = makeDispute('HELD');
      // Set fee to 600 on a 1000 escrow — 600 >= 500 (half), should be rejected
      disputeHighFee.request.escrow.platformFee = new Decimal('600.00');
      mockPrisma.dispute.findUnique.mockResolvedValue(disputeHighFee);

      await expect(service.resolveDispute('dispute-1', 'admin-1', 'SPLIT', 'notes')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('does not emit financial events when escrow is not HELD', async () => {
      mockPrisma.dispute.findUnique.mockResolvedValue(makeDispute('RELEASED'));
      mockPrisma.$transaction.mockImplementation(async (fn: any) => {
        await fn({
          dispute: { update: jest.fn().mockResolvedValue({}) },
        });
      });

      await service.resolveDispute('dispute-1', 'admin-1', 'RELEASE', 'notes');

      expect(mockEvents.emit).not.toHaveBeenCalledWith('escrow.released', expect.anything());
      // dispute.resolved and audit.log are always emitted
      expect(mockEvents.emit).toHaveBeenCalledWith('dispute.resolved', expect.anything());
    });
  });

  // ── getSystemHealth ──────────────────────────────────────────────────────
  describe('getSystemHealth', () => {
    it('returns health snapshot with correct structure', async () => {
      mockPrisma.user.count.mockResolvedValue(5);
      mockPrisma.serviceRequest.count.mockResolvedValue(10);
      mockPrisma.payment.count.mockResolvedValue(1);
      mockPrisma.dispute.count.mockResolvedValue(2);
      mockPrisma.providerProfile.count.mockResolvedValue(3);
      mockPrisma.escrow.aggregate.mockResolvedValue({
        _sum: { amount: new Decimal('50000.00') },
        _count: { id: 8 },
      });
      mockPrisma.scheduledJobLog.findMany.mockResolvedValue([{ id: 'log-1', ranAt: new Date() }]);

      const result = await service.getSystemHealth();

      expect(result).toMatchObject({
        activity: { newUsersToday: 5, requestsToday: 10, failedPaymentsToday: 1 },
        pendingActions: { openDisputes: 2, pendingVerifications: 3 },
        escrow: { count: 8, totalHeld: 50000 },
      });
      expect(result.schedulerHealth).toHaveLength(1);
      expect(result.timestamp).toBeInstanceOf(Date);
    });

    it('handles null escrow sum gracefully (no held escrow)', async () => {
      mockPrisma.user.count.mockResolvedValue(0);
      mockPrisma.serviceRequest.count.mockResolvedValue(0);
      mockPrisma.payment.count.mockResolvedValue(0);
      mockPrisma.dispute.count.mockResolvedValue(0);
      mockPrisma.providerProfile.count.mockResolvedValue(0);
      mockPrisma.escrow.aggregate.mockResolvedValue({
        _sum: { amount: null },
        _count: { id: 0 },
      });
      mockPrisma.scheduledJobLog.findMany.mockResolvedValue([]);

      const result = await service.getSystemHealth();

      expect(result.escrow.totalHeld).toBe(0);
    });
  });
});
