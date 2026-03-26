import { NotFoundException, ForbiddenException } from '@nestjs/common';
import { TrackingService } from './tracking.service';

const mockPrisma = {
  serviceRequest: { findUnique: jest.fn(), findMany: jest.fn() },
};

const makeRequest = (overrides = {}) => ({
  id: 'req-1',
  customerId: 'customer-1',
  providerId: 'provider-1',
  status: 'IN_PROGRESS',
  scheduledAt: new Date(),
  service: { nameAr: 'كهرباء', nameEn: 'Electrical', icon: '⚡' },
  customer: { profile: {} },
  provider: {
    profile: { nameAr: 'خالد', nameEn: null, avatarUrl: null },
    providerProfile: { ratingAvg: 4.8, completedJobs: 30 },
    phone: null,
  },
  ...overrides,
});

describe('TrackingService', () => {
  let service: TrackingService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new TrackingService(mockPrisma as any);
  });

  describe('getOrderTracking()', () => {
    it('returns tracking data for the customer of the request', async () => {
      mockPrisma.serviceRequest.findUnique.mockResolvedValue(makeRequest());

      const result = await service.getOrderTracking('customer-1', 'req-1');

      expect(result.requestId).toBe('req-1');
      expect(result.status).toBe('IN_PROGRESS');
      expect(result.trackingRoom).toBe('request:req-1');
    });

    it('returns tracking data for the provider of the request', async () => {
      mockPrisma.serviceRequest.findUnique.mockResolvedValue(makeRequest());

      const result = await service.getOrderTracking('provider-1', 'req-1');
      expect(result).toBeDefined();
    });

    it('throws NotFoundException when request does not exist', async () => {
      mockPrisma.serviceRequest.findUnique.mockResolvedValue(null);

      await expect(service.getOrderTracking('u1', 'req-none')).rejects.toThrow(NotFoundException);
    });

    it('throws ForbiddenException when user is not a party to the request', async () => {
      mockPrisma.serviceRequest.findUnique.mockResolvedValue(makeRequest());

      await expect(service.getOrderTracking('stranger-id', 'req-1')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('sets canCancel=true only when status is PENDING', async () => {
      mockPrisma.serviceRequest.findUnique.mockResolvedValue(makeRequest({ status: 'PENDING' }));
      const result = await service.getOrderTracking('customer-1', 'req-1');
      expect(result.canCancel).toBe(true);
    });

    it('sets canCancel=false when status is IN_PROGRESS', async () => {
      mockPrisma.serviceRequest.findUnique.mockResolvedValue(makeRequest({ status: 'IN_PROGRESS' }));
      const result = await service.getOrderTracking('customer-1', 'req-1');
      expect(result.canCancel).toBe(false);
    });
  });

  describe('getActiveOrders()', () => {
    it('filters by customerId for CUSTOMER role', async () => {
      mockPrisma.serviceRequest.findMany.mockResolvedValue([]);

      await service.getActiveOrders('u1', 'CUSTOMER');

      const where = mockPrisma.serviceRequest.findMany.mock.calls[0][0].where;
      expect(where.customerId).toBe('u1');
      expect(where.providerId).toBeUndefined();
    });

    it('filters by providerId for PROVIDER role', async () => {
      mockPrisma.serviceRequest.findMany.mockResolvedValue([]);

      await service.getActiveOrders('u1', 'PROVIDER');

      const where = mockPrisma.serviceRequest.findMany.mock.calls[0][0].where;
      expect(where.providerId).toBe('u1');
      expect(where.customerId).toBeUndefined();
    });
  });
});
