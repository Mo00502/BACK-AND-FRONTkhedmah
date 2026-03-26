import { NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { EquipmentReviewsService } from './equipment-reviews.service';

const mockPrisma = {
  equipmentRental: { findUnique: jest.fn() },
  equipmentReview: {
    findFirst: jest.fn(),
    create: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
    aggregate: jest.fn(),
  },
  equipment: { update: jest.fn() },
};

const mockEvents = { emit: jest.fn() };

const makeRental = (overrides = {}) => ({
  id: 'rental-1',
  renterId: 'user-1',
  equipmentId: 'equip-1',
  status: 'COMPLETED',
  ...overrides,
});

describe('EquipmentReviewsService', () => {
  let service: EquipmentReviewsService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new EquipmentReviewsService(mockPrisma as any, mockEvents as any);
  });

  describe('submit()', () => {
    it('creates a review and updates equipment rating on happy path', async () => {
      mockPrisma.equipmentRental.findUnique.mockResolvedValue(makeRental());
      mockPrisma.equipmentReview.findFirst.mockResolvedValue(null);
      mockPrisma.equipmentReview.create.mockResolvedValue({ id: 'rev-1', score: 5 });
      mockPrisma.equipmentReview.aggregate.mockResolvedValue({
        _avg: { score: 4.5 },
        _count: { score: 3 },
      });
      mockPrisma.equipment.update.mockResolvedValue({});

      const result = await service.submit('rental-1', 'user-1', { score: 5 });

      expect(result).toEqual({ id: 'rev-1', score: 5 });
      expect(mockPrisma.equipmentReview.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            rentalId: 'rental-1',
            equipmentId: 'equip-1',
            reviewerId: 'user-1',
            score: 5,
          }),
        }),
      );
    });

    it('updates equipment rating and reviewCount after creating review', async () => {
      mockPrisma.equipmentRental.findUnique.mockResolvedValue(makeRental());
      mockPrisma.equipmentReview.findFirst.mockResolvedValue(null);
      mockPrisma.equipmentReview.create.mockResolvedValue({ id: 'rev-1' });
      mockPrisma.equipmentReview.aggregate.mockResolvedValue({
        _avg: { score: 4.2 },
        _count: { score: 5 },
      });
      mockPrisma.equipment.update.mockResolvedValue({});

      await service.submit('rental-1', 'user-1', { score: 4 });

      expect(mockPrisma.equipment.update).toHaveBeenCalledWith({
        where: { id: 'equip-1' },
        data: { rating: 4.2, reviewCount: 5 },
      });
    });

    it('throws NotFoundException when rental does not exist', async () => {
      mockPrisma.equipmentRental.findUnique.mockResolvedValue(null);

      await expect(service.submit('bad-rental', 'user-1', { score: 4 })).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws ForbiddenException when user is not the renter', async () => {
      mockPrisma.equipmentRental.findUnique.mockResolvedValue(makeRental({ renterId: 'other-user' }));

      await expect(service.submit('rental-1', 'user-1', { score: 4 })).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('throws BadRequestException when rental is not yet completed', async () => {
      mockPrisma.equipmentRental.findUnique.mockResolvedValue(makeRental({ status: 'ACTIVE' }));

      await expect(service.submit('rental-1', 'user-1', { score: 4 })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('throws BadRequestException when rental has already been reviewed', async () => {
      mockPrisma.equipmentRental.findUnique.mockResolvedValue(makeRental());
      mockPrisma.equipmentReview.findFirst.mockResolvedValue({ id: 'existing-rev' });

      await expect(service.submit('rental-1', 'user-1', { score: 4 })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('emits equipment.reviewed event after successful review', async () => {
      mockPrisma.equipmentRental.findUnique.mockResolvedValue(makeRental());
      mockPrisma.equipmentReview.findFirst.mockResolvedValue(null);
      mockPrisma.equipmentReview.create.mockResolvedValue({ id: 'rev-1' });
      mockPrisma.equipmentReview.aggregate.mockResolvedValue({
        _avg: { score: 5 },
        _count: { score: 1 },
      });
      mockPrisma.equipment.update.mockResolvedValue({});

      await service.submit('rental-1', 'user-1', { score: 5 });

      expect(mockEvents.emit).toHaveBeenCalledWith('equipment.reviewed', {
        rentalId: 'rental-1',
        score: 5,
      });
    });
  });

  describe('listForEquipment()', () => {
    it('returns paginated reviews with total count', async () => {
      const reviews = [{ id: 'rev-1', score: 5 }];
      mockPrisma.equipmentReview.findMany.mockResolvedValue(reviews);
      mockPrisma.equipmentReview.count.mockResolvedValue(1);

      const result = await service.listForEquipment('equip-1');

      expect(result).toMatchObject({ reviews, total: 1, page: 1 });
    });

    it('queries only reviews for the specified equipment', async () => {
      mockPrisma.equipmentReview.findMany.mockResolvedValue([]);
      mockPrisma.equipmentReview.count.mockResolvedValue(0);

      await service.listForEquipment('equip-99');

      expect(mockPrisma.equipmentReview.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { equipmentId: 'equip-99' } }),
      );
    });
  });
});
