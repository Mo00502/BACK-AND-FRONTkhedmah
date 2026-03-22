import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { PromotionsService } from './promotions.service';
import { PrismaService } from '../../prisma/prisma.service';

// ── Mock factories ────────────────────────────────────────────────────────────

const mockPromo = (overrides: Partial<any> = {}) => ({
  id: 'promo-1',
  code: 'WELCOME20',
  type: 'PERCENT',
  value: 20,
  minOrderAmount: 50,
  maxDiscountAmount: 100,
  usageLimit: 1000,
  perUserLimit: 1,
  usedCount: 0,
  active: true,
  expiresAt: null,
  newUsersOnly: false,
  serviceIds: [],
  description: 'خصم 20%',
  ...overrides,
});

const buildPrismaMock = () => ({
  promoCode: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  promoRedemption: {
    count: jest.fn(),
    create: jest.fn(),
  },
  serviceRequest: { count: jest.fn() },
  $transaction: jest.fn(),
});

// ── Test suite ────────────────────────────────────────────────────────────────

describe('PromotionsService', () => {
  let service: PromotionsService;
  let prisma: ReturnType<typeof buildPrismaMock>;

  beforeEach(async () => {
    prisma = buildPrismaMock();

    const module: TestingModule = await Test.createTestingModule({
      providers: [PromotionsService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = module.get(PromotionsService);
  });

  // ── createPromo ─────────────────────────────────────────────────────────────
  describe('createPromo', () => {
    it('should create a new promo code with uppercased code', async () => {
      prisma.promoCode.findUnique.mockResolvedValue(null);
      prisma.promoCode.create.mockResolvedValue(mockPromo());

      await service.createPromo({
        code: 'welcome20',
        type: 'PERCENT',
        value: 20,
      });

      expect(prisma.promoCode.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ code: 'WELCOME20' }) }),
      );
    });

    it('should throw ConflictException if code already exists', async () => {
      prisma.promoCode.findUnique.mockResolvedValue(mockPromo());
      await expect(
        service.createPromo({ code: 'WELCOME20', type: 'PERCENT', value: 20 }),
      ).rejects.toThrow(ConflictException);
    });
  });

  // ── validateCode ────────────────────────────────────────────────────────────
  describe('validateCode', () => {
    it('should return discount details for a valid PERCENT promo', async () => {
      prisma.promoCode.findUnique.mockResolvedValue(mockPromo());
      prisma.promoRedemption.count.mockResolvedValue(0);

      const result = await service.validateCode('user-1', 'WELCOME20', 200);

      expect(result.valid).toBe(true);
      expect(result.discountAmount).toBe(40); // 20% of 200
      expect(result.finalAmount).toBe(160);
    });

    it('should cap PERCENT discount at maxDiscountAmount', async () => {
      // promo: 20% off, max 100 SAR
      prisma.promoCode.findUnique.mockResolvedValue(
        mockPromo({ value: 20, maxDiscountAmount: 30 }),
      );
      prisma.promoRedemption.count.mockResolvedValue(0);

      const result = await service.validateCode('user-1', 'WELCOME20', 1000);
      expect(result.discountAmount).toBe(30); // capped at 30
    });

    it('should calculate FIXED discount correctly', async () => {
      prisma.promoCode.findUnique.mockResolvedValue(mockPromo({ type: 'FIXED', value: 50 }));
      prisma.promoRedemption.count.mockResolvedValue(0);

      const result = await service.validateCode('user-1', 'WELCOME20', 200);
      expect(result.discountAmount).toBe(50);
    });

    it('should throw NotFoundException for inactive promo code', async () => {
      prisma.promoCode.findUnique.mockResolvedValue(mockPromo({ active: false }));
      await expect(service.validateCode('user-1', 'DEAD', 200)).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException when promo has expired', async () => {
      const past = new Date(Date.now() - 1000 * 60 * 60);
      prisma.promoCode.findUnique.mockResolvedValue(mockPromo({ expiresAt: past }));
      await expect(service.validateCode('user-1', 'WELCOME20', 200)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException when global usage limit is reached', async () => {
      prisma.promoCode.findUnique.mockResolvedValue(mockPromo({ usageLimit: 5, usedCount: 5 }));
      await expect(service.validateCode('user-1', 'WELCOME20', 200)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException when order is below minimum amount', async () => {
      prisma.promoCode.findUnique.mockResolvedValue(mockPromo({ minOrderAmount: 100 }));
      await expect(service.validateCode('user-1', 'WELCOME20', 50)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException when user has already redeemed the code', async () => {
      prisma.promoCode.findUnique.mockResolvedValue(mockPromo({ perUserLimit: 1 }));
      prisma.promoRedemption.count.mockResolvedValue(1);
      await expect(service.validateCode('user-1', 'WELCOME20', 200)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException when newUsersOnly and user has a completed request', async () => {
      prisma.promoCode.findUnique.mockResolvedValue(mockPromo({ newUsersOnly: true }));
      prisma.promoRedemption.count.mockResolvedValue(0);
      prisma.serviceRequest.count.mockResolvedValue(3);
      await expect(service.validateCode('user-1', 'WELCOME20', 200)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException when service restriction does not match', async () => {
      prisma.promoCode.findUnique.mockResolvedValue(mockPromo({ serviceIds: ['svc-A'] }));
      prisma.promoRedemption.count.mockResolvedValue(0);
      await expect(service.validateCode('user-1', 'WELCOME20', 200, 'svc-B')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  // ── redeemCode ──────────────────────────────────────────────────────────────
  describe('redeemCode', () => {
    it('should atomically create redemption and increment usedCount', async () => {
      // The service uses the interactive transaction form: $transaction(async tx => {...})
      // Mock it to execute the callback with a tx proxy that delegates to the outer mock
      prisma.$transaction.mockImplementation(async (fn: any) => {
        const tx = {
          promoCode: { findUnique: prisma.promoCode.findUnique, update: prisma.promoCode.update },
          promoRedemption: {
            count: prisma.promoRedemption.count,
            create: prisma.promoRedemption.create,
          },
        };
        return fn(tx);
      });
      prisma.promoCode.findUnique.mockResolvedValue(mockPromo());
      prisma.promoRedemption.count.mockResolvedValue(0);
      prisma.promoRedemption.create.mockResolvedValue({ id: 'red-1' });
      prisma.promoCode.update.mockResolvedValue(mockPromo({ usedCount: 1 }));

      const result = await service.redeemCode('user-1', 'promo-1', 'req-1', 40);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(result.discountAmount).toBe(40);
    });

    it('should throw NotFoundException for unknown promoId', async () => {
      prisma.$transaction.mockImplementation(async (fn: any) => {
        const tx = {
          promoCode: { findUnique: prisma.promoCode.findUnique, update: prisma.promoCode.update },
          promoRedemption: {
            count: prisma.promoRedemption.count,
            create: prisma.promoRedemption.create,
          },
        };
        return fn(tx);
      });
      prisma.promoCode.findUnique.mockResolvedValue(null);
      await expect(service.redeemCode('user-1', 'bad-id', 'req-1', 10)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ── deactivate ──────────────────────────────────────────────────────────────
  describe('deactivate', () => {
    it('should set active=false on the promo', async () => {
      prisma.promoCode.update.mockResolvedValue(mockPromo({ active: false }));

      await service.deactivate('promo-1');

      expect(prisma.promoCode.update).toHaveBeenCalledWith({
        where: { id: 'promo-1' },
        data: { active: false },
      });
    });
  });
});
