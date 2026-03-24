import { Test, TestingModule } from '@nestjs/testing';
import {
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  ConflictException,
} from '@nestjs/common';
import { ReviewsService } from './reviews.service';
import { PrismaService } from '../../prisma/prisma.service';
import { EventEmitter2 } from '@nestjs/event-emitter';

// ── Helpers ───────────────────────────────────────────────────────────────────

const makeRequest = (overrides: any = {}) => ({
  id: 'req-1',
  customerId: 'customer-1',
  providerId: 'provider-1',
  status: 'COMPLETED',
  customer: { id: 'customer-1' },
  provider: { id: 'provider-1' },
  ...overrides,
});

const makeReview = (overrides: any = {}) => ({
  id: 'review-1',
  requestId: 'req-1',
  raterId: 'customer-1',
  rateeId: 'provider-1',
  score: 5,
  comment: 'Great service',
  photos: [],
  createdAt: new Date(),
  ...overrides,
});

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockPrisma = {
  serviceRequest: {
    findUnique: jest.fn(),
  },
  review: {
    findUnique: jest.fn(),
    create: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
    groupBy: jest.fn(),
    aggregate: jest.fn(),
  },
  providerProfile: {
    update: jest.fn(),
  },
  $transaction: jest.fn(async (fn: any) => fn(mockPrisma)),
};

const mockEvents = { emit: jest.fn() };

// ── Test suite ────────────────────────────────────────────────────────────────

describe('ReviewsService', () => {
  let service: ReviewsService;

  beforeEach(async () => {
    jest.clearAllMocks();

    // Default $transaction implementation runs the callback with the mock prisma
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));

    // Default aggregate for rating calculation
    mockPrisma.review.aggregate.mockResolvedValue({
      _avg: { score: 5 },
      _count: { id: 1 },
    });

    mockPrisma.providerProfile.update.mockResolvedValue({});

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReviewsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: EventEmitter2, useValue: mockEvents },
      ],
    }).compile();

    service = module.get<ReviewsService>(ReviewsService);
  });

  // ── create ────────────────────────────────────────────────────────────────

  describe('create', () => {
    const dto = { score: 5, comment: 'Excellent work', photos: [] };

    it('creates a review when request is completed and rater is participant', async () => {
      mockPrisma.serviceRequest.findUnique.mockResolvedValue(makeRequest());
      mockPrisma.review.findUnique.mockResolvedValue(null); // not already reviewed
      mockPrisma.review.create.mockResolvedValue(makeReview());

      const result = await service.create('customer-1', 'req-1', dto);

      expect(mockPrisma.review.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            requestId: 'req-1',
            raterId: 'customer-1',
            rateeId: 'provider-1',
            score: 5,
          }),
        }),
      );
      expect(mockEvents.emit).toHaveBeenCalledWith(
        'review.submitted',
        expect.objectContaining({ requestId: 'req-1', raterId: 'customer-1' }),
      );
      expect(result.id).toBe('review-1');
    });

    it('throws NotFoundException when request does not exist', async () => {
      mockPrisma.serviceRequest.findUnique.mockResolvedValue(null);

      await expect(service.create('customer-1', 'req-1', dto)).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException when request is not COMPLETED', async () => {
      mockPrisma.serviceRequest.findUnique.mockResolvedValue(makeRequest({ status: 'IN_PROGRESS' }));

      await expect(service.create('customer-1', 'req-1', dto)).rejects.toThrow(BadRequestException);
    });

    it('throws ForbiddenException when rater is not a participant', async () => {
      mockPrisma.serviceRequest.findUnique.mockResolvedValue(makeRequest());

      await expect(service.create('third-party', 'req-1', dto)).rejects.toThrow(ForbiddenException);
    });

    it('throws ConflictException when rater already reviewed this request', async () => {
      mockPrisma.serviceRequest.findUnique.mockResolvedValue(makeRequest());
      mockPrisma.review.findUnique.mockResolvedValue(makeReview()); // already exists

      await expect(service.create('customer-1', 'req-1', dto)).rejects.toThrow(ConflictException);
    });

    it('updates provider rating when customer submits review', async () => {
      mockPrisma.serviceRequest.findUnique.mockResolvedValue(makeRequest());
      mockPrisma.review.findUnique.mockResolvedValue(null);
      mockPrisma.review.create.mockResolvedValue(makeReview());
      mockPrisma.review.aggregate.mockResolvedValue({ _avg: { score: 4.5 }, _count: { id: 10 } });

      await service.create('customer-1', 'req-1', dto);

      expect(mockPrisma.providerProfile.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 'provider-1' },
          data: expect.objectContaining({ ratingCount: 10 }),
        }),
      );
    });

    it('does NOT update provider rating when provider submits review on customer', async () => {
      mockPrisma.serviceRequest.findUnique.mockResolvedValue(makeRequest());
      mockPrisma.review.findUnique.mockResolvedValue(null);
      mockPrisma.review.create.mockResolvedValue(makeReview({ raterId: 'provider-1', rateeId: 'customer-1' }));

      await service.create('provider-1', 'req-1', dto);

      // providerProfile.update should NOT be called when provider reviews customer
      expect(mockPrisma.providerProfile.update).not.toHaveBeenCalled();
    });
  });
});
