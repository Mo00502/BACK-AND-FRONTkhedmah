import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { ProvidersService } from './providers.service';
import { PrismaService } from '../../prisma/prisma.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { ProviderVerificationStatus } from '@prisma/client';

// ── Helpers ───────────────────────────────────────────────────────────────────

const makeProfile = (overrides: any = {}) => ({
  id: 'profile-1',
  userId: 'user-1',
  verificationStatus: ProviderVerificationStatus.APPROVED,
  ratingAvg: 4.5,
  ratingCount: 10,
  completedJobs: 5,
  ...overrides,
});

const makeSkill = (overrides: any = {}) => ({
  id: 'skill-1',
  providerId: 'profile-1',
  serviceId: 'service-1',
  hourlyRate: 100,
  active: true,
  ...overrides,
});

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockPrisma = {
  providerProfile: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    count: jest.fn(),
    upsert: jest.fn(),
    updateMany: jest.fn(),
    update: jest.fn(),
  },
  providerSkill: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
    deleteMany: jest.fn(),
    update: jest.fn(),
    findMany: jest.fn(),
  },
  providerAvailability: {
    deleteMany: jest.fn(),
    createMany: jest.fn(),
    findMany: jest.fn(),
  },
  escrow: {
    aggregate: jest.fn(),
    findMany: jest.fn(),
    $queryRaw: jest.fn(),
  },
  $queryRaw: jest.fn(),
};

const mockEvents = { emit: jest.fn() };

// ── Test suite ────────────────────────────────────────────────────────────────

describe('ProvidersService', () => {
  let service: ProvidersService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProvidersService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: EventEmitter2, useValue: mockEvents },
      ],
    }).compile();

    service = module.get<ProvidersService>(ProvidersService);
  });

  // ── findAll ───────────────────────────────────────────────────────────────

  describe('findAll', () => {
    it('queries with verificationStatus APPROVED filter', async () => {
      mockPrisma.providerProfile.findMany.mockResolvedValue([makeProfile()]);
      mockPrisma.providerProfile.count.mockResolvedValue(1);

      const dto = new PaginationDto();
      await service.findAll(dto);

      expect(mockPrisma.providerProfile.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            verificationStatus: 'APPROVED',
          }),
        }),
      );
    });

    it('includes suspended: false in the user filter', async () => {
      mockPrisma.providerProfile.findMany.mockResolvedValue([]);
      mockPrisma.providerProfile.count.mockResolvedValue(0);

      const dto = new PaginationDto();
      await service.findAll(dto);

      expect(mockPrisma.providerProfile.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            user: expect.objectContaining({ suspended: false }),
          }),
        }),
      );
    });

    it('returns paginated result', async () => {
      const profiles = [makeProfile(), makeProfile({ id: 'profile-2', userId: 'user-2' })];
      mockPrisma.providerProfile.findMany.mockResolvedValue(profiles);
      mockPrisma.providerProfile.count.mockResolvedValue(2);

      const dto = new PaginationDto();
      const result = await service.findAll(dto);

      expect(result.items).toHaveLength(2);
      expect(result.total).toBe(2);
    });
  });

  // ── getEarnings ───────────────────────────────────────────────────────────

  describe('getEarnings', () => {
    beforeEach(() => {
      mockPrisma.providerProfile.findUnique.mockResolvedValue(makeProfile());
    });

    it('returns net earnings with 15% commission deducted', async () => {
      // Gross = 1000 SAR released
      mockPrisma.escrow.aggregate
        .mockResolvedValueOnce({ _sum: { amount: 1000 } }) // available (released)
        .mockResolvedValueOnce({ _sum: { amount: 200 } })  // pending (held)
        .mockResolvedValueOnce({ _sum: { amount: 1200 } }); // total

      const result = await service.getEarnings('user-1');

      // net = gross * 0.85
      expect(result.available).toBeCloseTo(850, 1); // 1000 * 0.85
      expect(result.pending).toBeCloseTo(170, 1);   // 200 * 0.85
      expect(result.commission).toBeCloseTo(180, 1); // 1200 * 0.15
      expect(result.net).toBeCloseTo(1020, 1);       // 1200 * 0.85
    });

    it('returns zero earnings when there are no escrows', async () => {
      mockPrisma.escrow.aggregate.mockResolvedValue({ _sum: { amount: null } });

      const result = await service.getEarnings('user-1');

      expect(result.available).toBe(0);
      expect(result.pending).toBe(0);
      expect(result.gross).toBe(0);
      expect(result.net).toBe(0);
      expect(result.commission).toBe(0);
    });

    it('throws NotFoundException when provider profile does not exist', async () => {
      mockPrisma.providerProfile.findUnique.mockResolvedValue(null);

      await expect(service.getEarnings('nonexistent')).rejects.toThrow(NotFoundException);
    });
  });

  // ── addSkill ──────────────────────────────────────────────────────────────

  describe('addSkill', () => {
    it('creates a skill when profile exists and skill is not duplicate', async () => {
      mockPrisma.providerProfile.findUnique.mockResolvedValue(makeProfile());
      mockPrisma.providerSkill.findUnique.mockResolvedValue(null);
      mockPrisma.providerSkill.create.mockResolvedValue(makeSkill());

      const result = await service.addSkill('user-1', { serviceId: 'service-1', hourlyRate: 100 });

      expect(mockPrisma.providerSkill.create).toHaveBeenCalled();
      expect(result.id).toBe('skill-1');
    });

    it('throws BadRequestException when hourlyRate is 0 or negative', async () => {
      await expect(
        service.addSkill('user-1', { serviceId: 'service-1', hourlyRate: 0 }),
      ).rejects.toThrow(BadRequestException);

      await expect(
        service.addSkill('user-1', { serviceId: 'service-1', hourlyRate: -50 }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws NotFoundException when provider profile does not exist', async () => {
      mockPrisma.providerProfile.findUnique.mockResolvedValue(null);

      await expect(
        service.addSkill('user-1', { serviceId: 'service-1', hourlyRate: 100 }),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws ConflictException when skill is already added', async () => {
      mockPrisma.providerProfile.findUnique.mockResolvedValue(makeProfile());
      mockPrisma.providerSkill.findUnique.mockResolvedValue(makeSkill()); // already exists

      await expect(
        service.addSkill('user-1', { serviceId: 'service-1', hourlyRate: 100 }),
      ).rejects.toThrow(ConflictException);
    });
  });
});
