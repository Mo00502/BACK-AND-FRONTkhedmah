import { Test, TestingModule } from '@nestjs/testing';
import { SearchService } from './search.service';
import { PrismaService } from '../../prisma/prisma.service';

const mockPrisma = {
  providerProfile: { findMany: jest.fn(), count: jest.fn() },
  service: { findMany: jest.fn() },
  serviceCategory: { findMany: jest.fn() },
  tender: { findMany: jest.fn(), count: jest.fn() },
  equipment: { findMany: jest.fn(), count: jest.fn() },
  userProfile: { findMany: jest.fn() },
};

describe('SearchService', () => {
  let service: SearchService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [SearchService, { provide: PrismaService, useValue: mockPrisma }],
    }).compile();
    service = module.get<SearchService>(SearchService);
  });

  // ── searchAll ──────────────────────────────────────────────────────────────
  describe('searchAll', () => {
    it('calls all four sub-searches in parallel', async () => {
      mockPrisma.providerProfile.findMany.mockResolvedValue([]);
      mockPrisma.providerProfile.count.mockResolvedValue(0);
      mockPrisma.service.findMany.mockResolvedValue([]);
      mockPrisma.tender.findMany.mockResolvedValue([]);
      mockPrisma.tender.count.mockResolvedValue(0);
      mockPrisma.equipment.findMany.mockResolvedValue([]);
      mockPrisma.equipment.count.mockResolvedValue(0);

      const result = await service.searchAll({ q: 'سباكة' });

      expect(result).toHaveProperty('providers');
      expect(result).toHaveProperty('services');
      expect(result).toHaveProperty('tenders');
      expect(result).toHaveProperty('equipment');
      expect(result.query).toBe('سباكة');
    });
  });

  // ── searchProviders ────────────────────────────────────────────────────────
  describe('searchProviders', () => {
    it('returns paginated providers', async () => {
      const providers = [{ id: 'prov-1' }, { id: 'prov-2' }];
      mockPrisma.providerProfile.findMany.mockResolvedValue(providers);
      mockPrisma.providerProfile.count.mockResolvedValue(2);

      const result = await service.searchProviders({ q: 'كهرباء', page: 1, limit: 10 });

      expect(result.items).toHaveLength(2);
      expect(result.total).toBe(2);
      expect(result.page).toBe(1);
      expect(result.pages).toBe(1);
    });

    it('applies city filter when provided', async () => {
      mockPrisma.providerProfile.findMany.mockResolvedValue([]);
      mockPrisma.providerProfile.count.mockResolvedValue(0);

      await service.searchProviders({ q: 'test', city: 'الرياض' });

      expect(mockPrisma.providerProfile.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            user: expect.objectContaining({ profile: { city: 'الرياض' } }),
          }),
        }),
      );
    });

    it('calculates correct pages count', async () => {
      mockPrisma.providerProfile.findMany.mockResolvedValue(Array(5).fill({}));
      mockPrisma.providerProfile.count.mockResolvedValue(25);

      const result = await service.searchProviders({ q: 'x', page: 1, limit: 5 });
      expect(result.pages).toBe(5);
    });
  });

  // ── searchTenders ──────────────────────────────────────────────────────────
  describe('searchTenders', () => {
    it('returns only OPEN tenders', async () => {
      mockPrisma.tender.findMany.mockResolvedValue([]);
      mockPrisma.tender.count.mockResolvedValue(0);

      await service.searchTenders({ q: 'إنشاء' });

      expect(mockPrisma.tender.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ status: 'OPEN' }) }),
      );
    });

    it('applies minPrice and maxPrice budget filters', async () => {
      mockPrisma.tender.findMany.mockResolvedValue([]);
      mockPrisma.tender.count.mockResolvedValue(0);

      await service.searchTenders({ q: 'بناء', minPrice: 500_000, maxPrice: 5_000_000 });

      const call = mockPrisma.tender.findMany.mock.calls[0][0];
      expect(call.where.budget).toMatchObject({ gte: 500_000, lte: 5_000_000 });
    });
  });

  // ── searchEquipment ────────────────────────────────────────────────────────
  describe('searchEquipment', () => {
    it('only returns ACTIVE + isAvailable equipment', async () => {
      mockPrisma.equipment.findMany.mockResolvedValue([]);
      mockPrisma.equipment.count.mockResolvedValue(0);

      await service.searchEquipment({ q: 'حفار' });

      const call = mockPrisma.equipment.findMany.mock.calls[0][0];
      expect(call.where.status).toBe('ACTIVE');
      expect(call.where.isAvailable).toBe(true);
    });

    it('filters by category when provided', async () => {
      mockPrisma.equipment.findMany.mockResolvedValue([]);
      mockPrisma.equipment.count.mockResolvedValue(0);

      await service.searchEquipment({ q: 'test', category: 'EXCAVATOR' });

      const call = mockPrisma.equipment.findMany.mock.calls[0][0];
      expect(call.where.category).toBe('EXCAVATOR');
    });
  });

  // ── autocomplete ───────────────────────────────────────────────────────────
  describe('autocomplete', () => {
    it('returns empty array for queries shorter than 2 chars', async () => {
      const result = await service.autocomplete('س');
      expect(result).toEqual([]);
      expect(mockPrisma.service.findMany).not.toHaveBeenCalled();
    });

    it('returns merged suggestions from services, categories, cities', async () => {
      mockPrisma.service.findMany.mockResolvedValue([{ nameAr: 'سباكة', nameEn: 'Plumbing' }]);
      mockPrisma.serviceCategory.findMany.mockResolvedValue([
        { nameAr: 'سباكة', nameEn: 'Plumbing', id: 'cat-1' },
      ]);
      mockPrisma.userProfile.findMany.mockResolvedValue([{ city: 'سبت العلايا' }]);

      const result = await service.autocomplete('سب');

      expect(result.length).toBeGreaterThan(0);
      expect(result.some((r) => r.type === 'service')).toBe(true);
      expect(result.some((r) => r.type === 'city')).toBe(true);
    });
  });
});
