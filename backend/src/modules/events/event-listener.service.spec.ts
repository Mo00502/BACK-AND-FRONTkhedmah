import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EventListenerService } from './event-listener.service';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { WalletService } from '../wallet/wallet.service';
import { PaymentsService } from '../payments/payments.service';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockPrisma = {
  escrow: { findUnique: jest.fn() },
  serviceRequest: { findUnique: jest.fn() },
  equipmentRental: { findUnique: jest.fn() },
  equipment: { findUnique: jest.fn() },
  materialsAdjustmentRequest: { findUnique: jest.fn() },
  materialsUsageLog: { findUnique: jest.fn() },
};

const mockNotif = {
  notifyUser: jest.fn().mockResolvedValue(undefined),
  createInApp: jest.fn().mockResolvedValue(undefined),
  sendEmail: jest.fn().mockResolvedValue(undefined),
};

const mockWallet = {
  credit: jest.fn().mockResolvedValue(undefined),
};

const mockPayments = {
  initiateRefund: jest.fn().mockResolvedValue(undefined),
};

const mockConfig = {
  get: jest.fn(),
};

// ── Test suite ────────────────────────────────────────────────────────────────

describe('EventListenerService', () => {
  let service: EventListenerService;

  beforeEach(async () => {
    jest.clearAllMocks();
    // Default: no ADMIN_EMAIL configured
    mockConfig.get.mockReturnValue('');

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EventListenerService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: NotificationsService, useValue: mockNotif },
        { provide: WalletService, useValue: mockWallet },
        { provide: PaymentsService, useValue: mockPayments },
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();

    service = module.get<EventListenerService>(EventListenerService);
  });

  // ── onEscrowReleased ───────────────────────────────────────────────────────

  describe('onEscrowReleased', () => {
    it('credits provider wallet with net payout (amount − platformFee)', async () => {
      mockPrisma.escrow.findUnique.mockResolvedValue({
        id: 'escrow-1',
        amount: 1000,
        platformFee: 150,
        requestId: 'req-1',
        request: { providerId: 'provider-1' },
      });

      await service.onEscrowReleased({ requestId: 'req-1' });

      expect(mockWallet.credit).toHaveBeenCalledWith(
        'provider-1',
        850, // 1000 − 150
        expect.any(String),
        'escrow-1',
      );
    });

    it('uses providerId from event payload when present (overrides escrow.request)', async () => {
      mockPrisma.escrow.findUnique.mockResolvedValue({
        id: 'escrow-2',
        amount: 500,
        platformFee: 75,
        requestId: 'req-2',
        request: { providerId: 'wrong-provider' },
      });

      await service.onEscrowReleased({ requestId: 'req-2', providerId: 'correct-provider' });

      expect(mockWallet.credit).toHaveBeenCalledWith(
        'correct-provider',
        425,
        expect.any(String),
        'escrow-2',
      );
    });

    it('skips wallet credit when escrow not found (logs warning, no throw)', async () => {
      mockPrisma.escrow.findUnique.mockResolvedValue(null);

      await expect(service.onEscrowReleased({ requestId: 'missing-req' })).resolves.toBeUndefined();
      expect(mockWallet.credit).not.toHaveBeenCalled();
    });

    it('skips wallet credit when netPayout is zero', async () => {
      mockPrisma.escrow.findUnique.mockResolvedValue({
        id: 'escrow-3',
        amount: 100,
        platformFee: 100, // 100% fee → net = 0
        requestId: 'req-3',
        request: { providerId: 'provider-1' },
      });

      await service.onEscrowReleased({ requestId: 'req-3' });
      expect(mockWallet.credit).not.toHaveBeenCalled();
    });

    it('skips wallet credit when no providerId available', async () => {
      mockPrisma.escrow.findUnique.mockResolvedValue({
        id: 'escrow-4',
        amount: 500,
        platformFee: 75,
        requestId: 'req-4',
        request: { providerId: null },
      });

      await service.onEscrowReleased({ requestId: 'req-4' });
      expect(mockWallet.credit).not.toHaveBeenCalled();
    });

    it('does not throw when wallet.credit fails (error is caught)', async () => {
      mockPrisma.escrow.findUnique.mockResolvedValue({
        id: 'escrow-5',
        amount: 500,
        platformFee: 75,
        requestId: 'req-5',
        request: { providerId: 'provider-1' },
      });
      mockWallet.credit.mockRejectedValue(new Error('DB connection lost'));

      await expect(service.onEscrowReleased({ requestId: 'req-5' })).resolves.toBeUndefined();
    });
  });

  // ── onCommissionsOverdue ───────────────────────────────────────────────────

  describe('onCommissionsOverdue', () => {
    it('sends email to ADMIN_EMAIL with overdue count', async () => {
      mockConfig.get.mockReturnValue('admin@khedmah.sa');

      await service.onCommissionsOverdue({ count: 5 });

      expect(mockNotif.sendEmail).toHaveBeenCalledWith(
        'admin@khedmah.sa',
        expect.stringContaining('5'),
        expect.stringContaining('5'),
      );
    });

    it('skips email when ADMIN_EMAIL not configured', async () => {
      mockConfig.get.mockReturnValue('');

      await service.onCommissionsOverdue({ count: 3 });

      expect(mockNotif.sendEmail).not.toHaveBeenCalled();
    });
  });

  // ── onTicketOpened ─────────────────────────────────────────────────────────

  describe('onTicketOpened', () => {
    it('sends urgent email for URGENT priority tickets', async () => {
      mockConfig.get.mockReturnValue('admin@khedmah.sa');

      await service.onTicketOpened({
        ticketId: 'ticket-abc-123',
        userId: 'user-1',
        category: 'payment',
        priority: 'URGENT',
      });

      // Subject uses first 8 chars of ticketId uppercased: 'ticket-abc-123' → 'TICKET-A'
      expect(mockNotif.sendEmail).toHaveBeenCalledWith(
        'admin@khedmah.sa',
        expect.stringContaining('TICKET'),
        expect.any(String),
      );
    });

    it('skips email for normal priority tickets', async () => {
      mockConfig.get.mockReturnValue('admin@khedmah.sa');

      await service.onTicketOpened({
        ticketId: 'ticket-1',
        userId: 'user-1',
        category: 'general',
        priority: 'NORMAL',
      });

      expect(mockNotif.sendEmail).not.toHaveBeenCalled();
    });
  });

  // ── onDisputeOpened ────────────────────────────────────────────────────────

  describe('onDisputeOpened', () => {
    it('notifies the user the dispute is filed against', async () => {
      await service.onDisputeOpened({
        disputeId: 'dispute-1',
        requestId: 'req-1',
        reporterId: 'customer-1',
        againstId: 'provider-1',
      });

      expect(mockNotif.notifyUser).toHaveBeenCalledWith(
        'provider-1',
        expect.stringContaining('نزاع'),
        expect.any(String),
        expect.objectContaining({ disputeId: 'dispute-1' }),
      );
    });
  });

  // ── onMaterialsFunded ──────────────────────────────────────────────────────

  describe('onMaterialsFunded', () => {
    it('notifies provider when materials payment is funded', async () => {
      mockPrisma.serviceRequest.findUnique.mockResolvedValue({ providerId: 'provider-1' });

      await service.onMaterialsFunded({ requestId: 'req-1', amount: 500 });

      expect(mockNotif.notifyUser).toHaveBeenCalledWith(
        'provider-1',
        expect.stringContaining('ميزانية'),
        expect.stringContaining('500'),
        expect.objectContaining({ requestId: 'req-1' }),
      );
    });

    it('skips notification when service request has no provider yet', async () => {
      mockPrisma.serviceRequest.findUnique.mockResolvedValue({ providerId: null });

      await service.onMaterialsFunded({ requestId: 'req-1', amount: 500 });

      expect(mockNotif.notifyUser).not.toHaveBeenCalled();
    });

    it('skips notification when service request not found', async () => {
      mockPrisma.serviceRequest.findUnique.mockResolvedValue(null);

      await service.onMaterialsFunded({ requestId: 'missing', amount: 500 });

      expect(mockNotif.notifyUser).not.toHaveBeenCalled();
    });
  });

  // ── onRentalStatusChanged ──────────────────────────────────────────────────

  describe('onRentalStatusChanged', () => {
    it('notifies renter for CONFIRMED status', async () => {
      mockPrisma.equipmentRental.findUnique.mockResolvedValue({
        renterId: 'renter-1',
        equipment: { name: 'حفار كاتربيلار' },
      });

      await service.onRentalStatusChanged({ id: 'rental-1', status: 'CONFIRMED' });

      expect(mockNotif.notifyUser).toHaveBeenCalledWith(
        'renter-1',
        expect.stringContaining('حفار'),
        expect.stringContaining('تأكيد'),
        expect.objectContaining({ rentalId: 'rental-1' }),
      );
    });

    it('skips notification for unknown status values', async () => {
      mockPrisma.equipmentRental.findUnique.mockResolvedValue({
        renterId: 'renter-1',
        equipment: { name: 'معدة' },
      });

      await service.onRentalStatusChanged({ id: 'rental-1', status: 'UNKNOWN_STATUS' });

      expect(mockNotif.notifyUser).not.toHaveBeenCalled();
    });

    it('skips notification when rental not found', async () => {
      mockPrisma.equipmentRental.findUnique.mockResolvedValue(null);

      await service.onRentalStatusChanged({ id: 'missing', status: 'CONFIRMED' });

      expect(mockNotif.notifyUser).not.toHaveBeenCalled();
    });
  });

  // ── onWalletDebited ────────────────────────────────────────────────────────

  describe('onWalletDebited', () => {
    it('creates in-app notification for wallet debit', async () => {
      await service.onWalletDebited({ userId: 'user-1', amount: 200, newBalance: 800 });

      expect(mockNotif.createInApp).toHaveBeenCalledWith(
        'user-1',
        expect.stringContaining('خصم'),
        expect.stringContaining('200'),
      );
    });
  });
});
