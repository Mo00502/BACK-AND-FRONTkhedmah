import { NotFoundException, ForbiddenException } from '@nestjs/common';
import { PortfolioService } from './portfolio.service';

const mockPrisma = {
  providerProfile: { findUnique: jest.fn() },
  portfolioItem: {
    findMany: jest.fn(),
    count: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    delete: jest.fn(),
  },
  certification: {
    findMany: jest.fn(),
    count: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    delete: jest.fn(),
    update: jest.fn(),
  },
};

describe('PortfolioService', () => {
  let service: PortfolioService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new PortfolioService(mockPrisma as any);
  });

  describe('addItem()', () => {
    it('creates a portfolio item for the provider', async () => {
      mockPrisma.providerProfile.findUnique.mockResolvedValue({ id: 'profile-1', userId: 'u1' });
      mockPrisma.portfolioItem.create.mockResolvedValue({ id: 'item-1' });

      const result = await service.addItem('u1', 'شغل سباكة', 'وصف', ['url1.jpg']);

      expect(mockPrisma.portfolioItem.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ providerId: 'profile-1', title: 'شغل سباكة' }),
        }),
      );
      expect(result).toEqual({ id: 'item-1' });
    });

    it('throws NotFoundException when user has no provider profile', async () => {
      mockPrisma.providerProfile.findUnique.mockResolvedValue(null);

      await expect(service.addItem('u1', 'title', 'desc', [])).rejects.toThrow(NotFoundException);
    });
  });

  describe('getPortfolio()', () => {
    it('returns paginated portfolio items for a provider', async () => {
      const items = [{ id: 'item-1' }];
      mockPrisma.portfolioItem.findMany.mockResolvedValue(items);
      mockPrisma.portfolioItem.count.mockResolvedValue(1);

      const result = await service.getPortfolio('p1');

      expect(result).toMatchObject({ items, total: 1, page: 1 });
    });
  });

  describe('removeItem()', () => {
    it('deletes item when user is the owner', async () => {
      mockPrisma.providerProfile.findUnique.mockResolvedValue({ id: 'profile-1', userId: 'u1' });
      mockPrisma.portfolioItem.findUnique.mockResolvedValue({ id: 'item-1', providerId: 'profile-1' });
      mockPrisma.portfolioItem.delete.mockResolvedValue({ id: 'item-1' });

      await service.removeItem('u1', 'item-1');
      expect(mockPrisma.portfolioItem.delete).toHaveBeenCalledWith({ where: { id: 'item-1' } });
    });

    it('throws NotFoundException when item does not exist', async () => {
      mockPrisma.providerProfile.findUnique.mockResolvedValue({ id: 'profile-1', userId: 'u1' });
      mockPrisma.portfolioItem.findUnique.mockResolvedValue(null);

      await expect(service.removeItem('u1', 'nonexistent')).rejects.toThrow(NotFoundException);
    });

    it('throws ForbiddenException when user does not own the item', async () => {
      mockPrisma.providerProfile.findUnique.mockResolvedValue({ id: 'profile-1', userId: 'u1' });
      mockPrisma.portfolioItem.findUnique.mockResolvedValue({
        id: 'item-1',
        providerId: 'other-profile',
      });

      await expect(service.removeItem('u1', 'item-1')).rejects.toThrow(ForbiddenException);
    });
  });

  describe('addCertification()', () => {
    it('creates a certification linked to the provider profile', async () => {
      mockPrisma.providerProfile.findUnique.mockResolvedValue({ id: 'profile-1', userId: 'u1' });
      mockPrisma.certification.create.mockResolvedValue({ id: 'cert-1' });

      const result = await service.addCertification(
        'u1',
        'شهادة كهربائي',
        'المركز السعودي',
        new Date('2023-01-01'),
      );

      expect(mockPrisma.certification.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ providerId: 'profile-1', verified: false }),
        }),
      );
      expect(result).toEqual({ id: 'cert-1' });
    });
  });
});
