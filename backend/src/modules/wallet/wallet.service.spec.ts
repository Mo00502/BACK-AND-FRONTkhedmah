import { Test, TestingModule } from '@nestjs/testing';
import { WalletService } from './wallet.service';
import { PrismaService } from '../../prisma/prisma.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { BadRequestException } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';

const mockPrisma = {
  wallet: {
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  walletTransaction: {
    create: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
  },
  $transaction: jest.fn(),
};

const mockEvents = { emit: jest.fn() };

const mockWallet = (balance: number, held = 0) => ({
  id: 'wallet-1',
  userId: 'user-1',
  balance: new Decimal(balance),
  heldBalance: new Decimal(held),
});

describe('WalletService', () => {
  let service: WalletService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WalletService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: EventEmitter2, useValue: mockEvents },
      ],
    }).compile();
    service = module.get<WalletService>(WalletService);
  });

  // ── getOrCreate ────────────────────────────────────────────────────────────
  describe('getOrCreate', () => {
    it('returns existing wallet', async () => {
      const wallet = mockWallet(100);
      mockPrisma.wallet.findUnique.mockResolvedValue(wallet);
      const result = await service.getOrCreate('user-1');
      expect(result).toBe(wallet);
      expect(mockPrisma.wallet.create).not.toHaveBeenCalled();
    });

    it('creates wallet when none exists', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue(null);
      mockPrisma.wallet.create.mockResolvedValue(mockWallet(0));
      await service.getOrCreate('user-1');
      expect(mockPrisma.wallet.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: { userId: 'user-1', balance: 0, heldBalance: 0 } }),
      );
    });
  });

  // ── getBalance ─────────────────────────────────────────────────────────────
  describe('getBalance', () => {
    it('returns balance, heldBalance, and available', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue(mockWallet(300, 100));
      const result = await service.getBalance('user-1');
      expect(Number(result.balance)).toBe(300);
      expect(Number(result.heldBalance)).toBe(100);
      expect(Number(result.available)).toBe(200);
    });
  });

  // ── credit ─────────────────────────────────────────────────────────────────
  describe('credit', () => {
    it('increases balance and creates transaction record', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue(mockWallet(100));
      mockPrisma.$transaction.mockResolvedValue([]);

      await service.credit('user-1', 50, 'test credit');

      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
      expect(mockEvents.emit).toHaveBeenCalledWith(
        'wallet.credited',
        expect.objectContaining({ userId: 'user-1', amount: 50 }),
      );
    });
  });

  // ── debit ──────────────────────────────────────────────────────────────────
  describe('debit', () => {
    it('throws BadRequestException when insufficient balance', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue(mockWallet(50, 0));
      await expect(service.debit('user-1', 100, 'over-spend')).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when held balance blocks spending', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue(mockWallet(200, 150)); // available = 50
      await expect(service.debit('user-1', 100, 'blocked')).rejects.toThrow(BadRequestException);
    });

    it('decreases balance when sufficient funds available', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue(mockWallet(500, 0));
      mockPrisma.$transaction.mockResolvedValue([]);

      await service.debit('user-1', 200, 'payment');

      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
      expect(mockEvents.emit).toHaveBeenCalledWith(
        'wallet.debited',
        expect.objectContaining({ amount: 200 }),
      );
    });
  });

  // ── creditReferralReward ───────────────────────────────────────────────────
  describe('creditReferralReward', () => {
    it('credits both referrer and referee and emits event', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue(mockWallet(0));
      mockPrisma.$transaction.mockResolvedValue([]);

      await service.creditReferralReward('ref-1', 'new-1', 50);

      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(2); // once per credit
      expect(mockEvents.emit).toHaveBeenCalledWith(
        'referral.credited_referrer',
        expect.objectContaining({ userId: 'ref-1', refereeId: 'new-1', amount: 50 }),
      );
      expect(mockEvents.emit).toHaveBeenCalledWith(
        'referral.credited_referee',
        expect.objectContaining({ userId: 'new-1', referrerId: 'ref-1', amount: 50 }),
      );
    });
  });
});
