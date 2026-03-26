import { BadRequestException } from '@nestjs/common';
import { FavouritesService } from './favourites.service';

const mockPrisma = {
  favourite: {
    findUnique: jest.fn(),
    create: jest.fn(),
    delete: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
  },
  providerProfile: { findUnique: jest.fn() },
  equipment: { findUnique: jest.fn() },
  tender: { findUnique: jest.fn() },
};

describe('FavouritesService', () => {
  let service: FavouritesService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new FavouritesService(mockPrisma as any);
  });

  describe('toggle()', () => {
    it('creates a favourite when none exists (returns saved: true)', async () => {
      mockPrisma.favourite.findUnique.mockResolvedValue(null);
      mockPrisma.favourite.create.mockResolvedValue({ id: 'f1' });

      const result = await service.toggle('u1', 'PROVIDER', 'p1');

      expect(mockPrisma.favourite.create).toHaveBeenCalledWith({
        data: { userId: 'u1', refType: 'PROVIDER', refId: 'p1' },
      });
      expect(result).toEqual({ saved: true });
    });

    it('removes an existing favourite (returns saved: false)', async () => {
      mockPrisma.favourite.findUnique.mockResolvedValue({ id: 'f1' });
      mockPrisma.favourite.delete.mockResolvedValue({ id: 'f1' });

      const result = await service.toggle('u1', 'PROVIDER', 'p1');

      expect(mockPrisma.favourite.delete).toHaveBeenCalledWith({ where: { id: 'f1' } });
      expect(result).toEqual({ saved: false });
    });

    it('throws BadRequestException for invalid refType', async () => {
      await expect(service.toggle('u1', 'INVALID' as any, 'p1')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('listMine()', () => {
    it('returns all favourites for user without type filter', async () => {
      const favs = [{ id: 'f1', refType: 'PROVIDER', refId: 'p1', createdAt: new Date() }];
      mockPrisma.favourite.findMany.mockResolvedValue(favs);
      mockPrisma.providerProfile.findUnique.mockResolvedValue({ id: 'p1' });

      const result = await service.listMine('u1');
      expect(result).toHaveLength(1);
    });

    it('filters by refType when provided', async () => {
      mockPrisma.favourite.findMany.mockResolvedValue([]);

      await service.listMine('u1', 'EQUIPMENT');

      const whereArg = mockPrisma.favourite.findMany.mock.calls[0][0].where;
      expect(whereArg.refType).toBe('EQUIPMENT');
    });

    it('excludes favourites whose entity has been deleted (entity is null)', async () => {
      const favs = [{ id: 'f1', refType: 'EQUIPMENT', refId: 'eq-deleted', createdAt: new Date() }];
      mockPrisma.favourite.findMany.mockResolvedValue(favs);
      mockPrisma.equipment.findUnique.mockResolvedValue(null);

      const result = await service.listMine('u1', 'EQUIPMENT');
      expect(result).toHaveLength(0);
    });
  });

  describe('isSaved()', () => {
    it('returns { saved: true } when favourite exists', async () => {
      mockPrisma.favourite.findUnique.mockResolvedValue({ id: 'f1' });

      const result = await service.isSaved('u1', 'TENDER', 't1');
      expect(result).toEqual({ saved: true });
    });

    it('returns { saved: false } when not saved', async () => {
      mockPrisma.favourite.findUnique.mockResolvedValue(null);

      const result = await service.isSaved('u1', 'TENDER', 't1');
      expect(result).toEqual({ saved: false });
    });
  });
});
