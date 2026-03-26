import { ReportsService } from './reports.service';

const mockPrisma = {
  user: { count: jest.fn() },
  serviceRequest: { count: jest.fn(), groupBy: jest.fn() },
  escrow: { aggregate: jest.fn() },
  tenderCommission: { aggregate: jest.fn() },
  dispute: { count: jest.fn() },
  providerProfile: { count: jest.fn() },
};

const mockConfig = {
  get: jest.fn((key: string, fallback?: any) => {
    const cfg: Record<string, any> = {
      SMTP_HOST: null, // no SMTP by default in tests
    };
    return cfg[key] ?? fallback;
  }),
};

describe('ReportsService', () => {
  let service: ReportsService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new ReportsService(mockPrisma as any, mockConfig as any);
  });

  describe('buildWeeklyReport()', () => {
    const setupMocks = () => {
      mockPrisma.user.count.mockResolvedValue(10);
      mockPrisma.serviceRequest.count.mockResolvedValue(5);
      mockPrisma.escrow.aggregate.mockResolvedValue({
        _sum: { platformFee: 1500, amount: 10000 },
      });
      mockPrisma.tenderCommission.aggregate.mockResolvedValue({
        _sum: { commissionAmount: 200 },
      });
      mockPrisma.dispute.count.mockResolvedValue(2);
      mockPrisma.serviceRequest.groupBy.mockResolvedValue([]);
    };

    it('returns a report with the correct shape', async () => {
      setupMocks();

      const report = await service.buildWeeklyReport();

      expect(report).toMatchObject({
        users: { newCustomers: 10, newProviders: 10 },
        requests: { created: 5, completed: 5 },
        openDisputes: 2,
      });
      expect(report.period.from).toBeDefined();
      expect(report.period.to).toBeDefined();
      expect(report.generatedAt).toBeDefined();
    });

    it('calculates total revenue as homeServices + tenders', async () => {
      setupMocks();

      const report = await service.buildWeeklyReport();

      expect(report.revenue.homeServices).toBe(1500);
      expect(report.revenue.tenders).toBe(200);
      expect(report.revenue.total).toBe(1700);
    });

    it('handles null aggregate sums without throwing', async () => {
      mockPrisma.user.count.mockResolvedValue(0);
      mockPrisma.serviceRequest.count.mockResolvedValue(0);
      mockPrisma.escrow.aggregate.mockResolvedValue({ _sum: { platformFee: null, amount: null } });
      mockPrisma.tenderCommission.aggregate.mockResolvedValue({ _sum: { commissionAmount: null } });
      mockPrisma.dispute.count.mockResolvedValue(0);
      mockPrisma.serviceRequest.groupBy.mockResolvedValue([]);

      const report = await service.buildWeeklyReport();

      expect(report.revenue.total).toBe(0);
      expect(report.revenue.gmv).toBe(0);
    });
  });

  describe('getOverviewData()', () => {
    it('returns a snapshot with alerts', async () => {
      mockPrisma.user.count.mockResolvedValueOnce(100).mockResolvedValueOnce(50);
      mockPrisma.providerProfile.count
        .mockResolvedValueOnce(40)  // activeProviders
        .mockResolvedValueOnce(3);  // pendingVerifications
      mockPrisma.serviceRequest.count
        .mockResolvedValueOnce(8)   // requestsToday
        .mockResolvedValueOnce(5);  // completedToday
      mockPrisma.escrow.aggregate.mockResolvedValue({ _sum: { platformFee: 500 } });
      mockPrisma.dispute.count.mockResolvedValue(1);

      const result = await service.getOverviewData();

      expect(result.snapshot.totalCustomers).toBe(100);
      expect(result.snapshot.activeProviders).toBe(40);
      expect(result.alerts.openDisputes).toBe(1);
      expect(result.alerts.pendingVerifications).toBe(3);
    });
  });
});
