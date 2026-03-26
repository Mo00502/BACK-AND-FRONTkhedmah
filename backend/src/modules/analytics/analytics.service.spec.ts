import { Test, TestingModule } from '@nestjs/testing';
import { AnalyticsService } from './analytics.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ProviderVerificationStatus, CommissionStatus } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';

const mockPrisma = {
  user: {
    count: jest.fn(),
  },
  providerProfile: {
    count: jest.fn(),
    findMany: jest.fn(),
  },
  serviceRequest: {
    count: jest.fn(),
    groupBy: jest.fn(),
  },
  escrow: {
    aggregate: jest.fn(),
  },
  tenderCommission: {
    aggregate: jest.fn(),
  },
  equipmentRental: {
    aggregate: jest.fn(),
  },
  equipment: {
    count: jest.fn(),
    groupBy: jest.fn(),
    findMany: jest.fn(),
  },
  tender: {
    groupBy: jest.fn(),
  },
  consultation: {
    groupBy: jest.fn(),
    aggregate: jest.fn(),
  },
  $queryRaw: jest.fn(),
};

describe('AnalyticsService', () => {
  let service: AnalyticsService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AnalyticsService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<AnalyticsService>(AnalyticsService);
  });

  // ── getPlatformOverview ────────────────────────────────────────────────────
  describe('getPlatformOverview', () => {
    const setupOverviewMocks = ({
      users = 100,
      providers = 20,
      requests = 50,
      escrowAmount = 0,
      escrowFee = 0,
      tenderCommission = 0,
      equipmentPrice = 0,
    } = {}) => {
      mockPrisma.user.count.mockResolvedValue(users);
      mockPrisma.providerProfile.count.mockResolvedValue(providers);
      mockPrisma.serviceRequest.count.mockResolvedValue(requests);
      mockPrisma.escrow.aggregate.mockResolvedValue({
        _sum: { amount: new Decimal(escrowAmount), platformFee: new Decimal(escrowFee) },
      });
      mockPrisma.tenderCommission.aggregate.mockResolvedValue({
        _sum: { commissionAmount: new Decimal(tenderCommission) },
      });
      mockPrisma.equipmentRental.aggregate.mockResolvedValue({
        _sum: { totalPrice: new Decimal(equipmentPrice) },
      });
      mockPrisma.serviceRequest.groupBy.mockResolvedValue([]);
    };

    it('returns totalUsers, verifiedProviders, and completedRequests', async () => {
      setupOverviewMocks({ users: 500, providers: 80, requests: 200 });

      const result = await service.getPlatformOverview();

      expect(result.totalUsers).toBe(500);
      expect(result.verifiedProviders).toBe(80);
      expect(result.completedRequests).toBe(200);
    });

    it('queries providers with APPROVED verification status only', async () => {
      setupOverviewMocks();

      await service.getPlatformOverview();

      expect(mockPrisma.providerProfile.count).toHaveBeenCalledWith({
        where: { verificationStatus: ProviderVerificationStatus.APPROVED },
      });
    });

    it('queries escrow aggregates with RELEASED status', async () => {
      setupOverviewMocks();

      await service.getPlatformOverview();

      expect(mockPrisma.escrow.aggregate).toHaveBeenCalledWith(
        expect.objectContaining({ where: { status: 'RELEASED' } }),
      );
    });

    it('queries tenderCommission with PAID status', async () => {
      setupOverviewMocks();

      await service.getPlatformOverview();

      expect(mockPrisma.tenderCommission.aggregate).toHaveBeenCalledWith(
        expect.objectContaining({ where: { status: CommissionStatus.PAID } }),
      );
    });

    it('calculates totalPlatformRevenue as sum of all fee verticals', async () => {
      setupOverviewMocks({ escrowFee: 150, tenderCommission: 50, equipmentPrice: 1000 });

      const result = await service.getPlatformOverview();

      // homeFees(150) + tenderFees(50) + equipmentFeeEst(1000 * 0.1 = 100) = 300
      expect(result.revenue.totalPlatformRevenue).toBeCloseTo(300);
    });

    it('returns zero revenue gracefully when aggregates return null sums', async () => {
      mockPrisma.user.count.mockResolvedValue(0);
      mockPrisma.providerProfile.count.mockResolvedValue(0);
      mockPrisma.serviceRequest.count.mockResolvedValue(0);
      mockPrisma.escrow.aggregate.mockResolvedValue({ _sum: { amount: null, platformFee: null } });
      mockPrisma.tenderCommission.aggregate.mockResolvedValue({ _sum: { commissionAmount: null } });
      mockPrisma.equipmentRental.aggregate.mockResolvedValue({ _sum: { totalPrice: null } });
      mockPrisma.serviceRequest.groupBy.mockResolvedValue([]);

      const result = await service.getPlatformOverview();

      expect(result.revenue.totalPlatformRevenue).toBe(0);
    });
  });

  // ── getTopProviders ────────────────────────────────────────────────────────
  describe('getTopProviders', () => {
    it('returns providers ordered by completedJobs and ratingAvg', async () => {
      const providers = [
        { id: 'p1', completedJobs: 50, ratingAvg: new Decimal(4.8), user: { suspended: false } },
        { id: 'p2', completedJobs: 30, ratingAvg: new Decimal(4.5), user: { suspended: false } },
      ];
      mockPrisma.providerProfile.findMany.mockResolvedValue(providers);

      const result = await service.getTopProviders(10);

      expect(result).toHaveLength(2);
      expect(mockPrisma.providerProfile.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: [{ completedJobs: 'desc' }, { ratingAvg: 'desc' }],
          take: 10,
        }),
      );
    });

    it('MUST exclude suspended providers from results', async () => {
      mockPrisma.providerProfile.findMany.mockResolvedValue([]);

      await service.getTopProviders(5);

      expect(mockPrisma.providerProfile.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            user: expect.objectContaining({ suspended: false }),
          }),
        }),
      );
    });

    it('MUST filter to APPROVED verification status only', async () => {
      mockPrisma.providerProfile.findMany.mockResolvedValue([]);

      await service.getTopProviders(5);

      expect(mockPrisma.providerProfile.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            verificationStatus: ProviderVerificationStatus.APPROVED,
          }),
        }),
      );
    });

    it('uses default limit of 10 when no limit is provided', async () => {
      mockPrisma.providerProfile.findMany.mockResolvedValue([]);

      await service.getTopProviders();

      expect(mockPrisma.providerProfile.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 10 }),
      );
    });
  });

  // ── getMonthlyTrends ───────────────────────────────────────────────────────
  describe('getMonthlyTrends', () => {
    it('returns requestTrend, revenueTrend, userGrowth, and tenderTrend', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([]);

      const result = await service.getMonthlyTrends(6);

      expect(result).toHaveProperty('requestTrend');
      expect(result).toHaveProperty('revenueTrend');
      expect(result).toHaveProperty('userGrowth');
      expect(result).toHaveProperty('tenderTrend');
      // 4 raw queries: requestTrend, revenueTrend, userGrowth, tenderTrend
      expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(4);
    });

    it('defaults to 12 months when no argument provided', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([]);

      // Should not throw and should run the 4 queries
      await expect(service.getMonthlyTrends()).resolves.toBeDefined();
      expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(4);
    });
  });

  // ── getConversionFunnel ────────────────────────────────────────────────────
  describe('getConversionFunnel', () => {
    it('calculates correct conversion rates', async () => {
      mockPrisma.serviceRequest.count
        .mockResolvedValueOnce(200)  // created
        .mockResolvedValueOnce(150)  // quoted
        .mockResolvedValueOnce(100)  // paid
        .mockResolvedValueOnce(80);  // completed

      const result = await service.getConversionFunnel();

      expect(result.created).toBe(200);
      expect(result.quoted).toBe(150);
      expect(result.paid).toBe(100);
      expect(result.completed).toBe(80);
      expect(result.quotedRate).toBe(75);   // 150/200
      expect(result.paidRate).toBe(67);     // 100/150
      expect(result.completionRate).toBe(80); // 80/100
    });

    it('returns zero rates when no requests exist', async () => {
      mockPrisma.serviceRequest.count.mockResolvedValue(0);

      const result = await service.getConversionFunnel();

      expect(result.quotedRate).toBe(0);
      expect(result.paidRate).toBe(0);
      expect(result.completionRate).toBe(0);
    });
  });
});
