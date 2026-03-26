import { NotFoundException } from '@nestjs/common';
import { ServicesService } from './services.service';

const mockPrisma = {
  serviceCategory: { findMany: jest.fn() },
  service: { findMany: jest.fn(), findUnique: jest.fn(), count: jest.fn() },
  providerSkill: { findMany: jest.fn(), count: jest.fn() },
};

const mockCache = {
  get: jest.fn(),
  set: jest.fn(),
};

describe('ServicesService', () => {
  let service: ServicesService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new ServicesService(mockPrisma as any, mockCache as any);
  });

  describe('findAllCategories()', () => {
    it('returns cached data when cache hit', async () => {
      const cached = [{ id: '1', nameAr: 'كهرباء', services: [] }];
      mockCache.get.mockResolvedValue(cached);

      const result = await service.findAllCategories();

      expect(result).toBe(cached);
      expect(mockPrisma.serviceCategory.findMany).not.toHaveBeenCalled();
    });

    it('fetches from DB and populates cache on cache miss', async () => {
      mockCache.get.mockResolvedValue(null);
      const categories = [{ id: '1', nameAr: 'كهرباء', services: [] }];
      mockPrisma.serviceCategory.findMany.mockResolvedValue(categories);

      const result = await service.findAllCategories();

      expect(result).toBe(categories);
      expect(mockCache.set).toHaveBeenCalledWith('services:categories', categories, 3_600_000);
    });
  });

  describe('findAll()', () => {
    it('returns paginated services with category filter', async () => {
      const dto = { categoryId: 'cat-1', skip: 0, limit: 10 } as any;
      const services = [{ id: 's1', nameAr: 'تركيب', category: {} }];
      mockPrisma.service.findMany.mockResolvedValue(services);
      mockPrisma.service.count.mockResolvedValue(1);

      const result = await service.findAll(dto);

      expect(mockPrisma.service.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ categoryId: 'cat-1' }) }),
      );
      expect(result).toMatchObject({ items: services, total: 1 });
    });

    it('applies search filter when dto.search is provided', async () => {
      const dto = { search: 'كهرباء', skip: 0, limit: 10 } as any;
      mockPrisma.service.findMany.mockResolvedValue([]);
      mockPrisma.service.count.mockResolvedValue(0);

      await service.findAll(dto);

      const whereArg = mockPrisma.service.findMany.mock.calls[0][0].where;
      expect(whereArg.OR).toBeDefined();
    });
  });

  describe('findById()', () => {
    it('returns service when found', async () => {
      const svc = { id: 'svc-1', nameAr: 'تركيب', category: {} };
      mockPrisma.service.findUnique.mockResolvedValue(svc);

      const result = await service.findById('svc-1');
      expect(result).toBe(svc);
    });

    it('throws NotFoundException when service does not exist', async () => {
      mockPrisma.service.findUnique.mockResolvedValue(null);
      await expect(service.findById('nonexistent')).rejects.toThrow(NotFoundException);
    });
  });

  describe('findProvidersByService()', () => {
    it('throws NotFoundException when the service does not exist', async () => {
      mockPrisma.service.findUnique.mockResolvedValue(null);
      const dto = { skip: 0, limit: 10 } as any;
      await expect(service.findProvidersByService('bad-id', dto)).rejects.toThrow(NotFoundException);
    });

    it('returns paginated provider skills for valid service', async () => {
      mockPrisma.service.findUnique.mockResolvedValue({ id: 'svc-1' });
      const skills = [{ id: 'sk1', provider: {} }];
      mockPrisma.providerSkill.findMany.mockResolvedValue(skills);
      mockPrisma.providerSkill.count.mockResolvedValue(1);

      const dto = { skip: 0, limit: 10 } as any;
      const result = await service.findProvidersByService('svc-1', dto);
      expect(result).toMatchObject({ items: skills, total: 1 });
    });
  });
});
