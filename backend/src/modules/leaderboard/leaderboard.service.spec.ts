import { LeaderboardService } from './leaderboard.service';
import { ProviderVerificationStatus } from '@prisma/client';

const mockPrisma = {
  providerProfile: { findMany: jest.fn(), findUnique: jest.fn() },
  serviceRequest: { count: jest.fn() },
  $queryRaw: jest.fn(),
};

describe('LeaderboardService', () => {
  let service: LeaderboardService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new LeaderboardService(mockPrisma as any);
  });

  describe('getLeaderboard()', () => {
    const makeProvider = (overrides = {}) => ({
      id: 'p1',
      completedJobs: 15,
      ratingAvg: 4.9,
      user: { profile: { nameAr: 'خالد', nameEn: null, avatarUrl: null } },
      ...overrides,
    });

    it('returns ranked providers with badges for OVERALL category', async () => {
      mockPrisma.providerProfile.findMany.mockResolvedValue([makeProvider()]);

      const result = await service.getLeaderboard('OVERALL', 10);

      expect(result).toHaveLength(1);
      expect(result[0].rank).toBe(1);
      expect(result[0].name).toBe('خالد');
      expect(mockPrisma.providerProfile.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            verificationStatus: ProviderVerificationStatus.APPROVED,
          }),
        }),
      );
    });

    it('respects the limit parameter', async () => {
      mockPrisma.providerProfile.findMany.mockResolvedValue([]);

      await service.getLeaderboard('OVERALL', 5);

      expect(mockPrisma.providerProfile.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 5 }),
      );
    });

    it('adds a date filter for WEEKLY category', async () => {
      mockPrisma.providerProfile.findMany.mockResolvedValue([]);

      await service.getLeaderboard('WEEKLY');

      const where = mockPrisma.providerProfile.findMany.mock.calls[0][0].where;
      expect(where.user.requestsAsProvider).toBeDefined();
    });

    it('adds a date filter for MONTHLY category', async () => {
      mockPrisma.providerProfile.findMany.mockResolvedValue([]);

      await service.getLeaderboard('MONTHLY');

      const where = mockPrisma.providerProfile.findMany.mock.calls[0][0].where;
      expect(where.user.requestsAsProvider).toBeDefined();
    });
  });

  describe('getMyBadges()', () => {
    it('returns empty array when no provider profile found', async () => {
      mockPrisma.providerProfile.findUnique.mockResolvedValue(null);

      const result = await service.getMyBadges('u1');
      expect(result).toEqual([]);
    });

    it('computes correct badges for a top-rated provider with 50+ jobs', async () => {
      mockPrisma.providerProfile.findUnique.mockResolvedValue({
        completedJobs: 50,
        ratingAvg: 4.8,
      });

      const result = await service.getMyBadges('u1');
      const keys = result.map((b) => b.key);
      expect(keys).toContain('TOP_RATED');
      expect(keys).toContain('SUPER_PROVIDER');
    });

    it('only returns FIRST_JOB badge for a provider with 1 completed job', async () => {
      mockPrisma.providerProfile.findUnique.mockResolvedValue({
        completedJobs: 1,
        ratingAvg: 3.5,
      });

      const result = await service.getMyBadges('u1');
      const keys = result.map((b) => b.key);
      expect(keys).toEqual(['FIRST_JOB']);
    });
  });

  describe('getProviderStats()', () => {
    it('returns stats with monthly jobs and repeat customers', async () => {
      mockPrisma.providerProfile.findUnique.mockResolvedValue({
        completedJobs: 20,
        ratingAvg: 4.5,
        createdAt: new Date('2024-01-01'),
        userId: 'u1',
      });
      mockPrisma.serviceRequest.count.mockResolvedValue(3);
      mockPrisma.$queryRaw.mockResolvedValue([{ repeat_customers: '2' }]);

      const result = await service.getProviderStats('p1');

      expect(result.completedJobs).toBe(20);
      expect(result.jobsThisMonth).toBe(3);
      expect(result.repeatCustomers).toBe(2);
    });
  });
});
