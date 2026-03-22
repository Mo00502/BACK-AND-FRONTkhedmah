import { Test, TestingModule } from '@nestjs/testing';
import { TendersService } from './tenders.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CompaniesService } from '../companies/companies.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';

// ── Mock factories ───────────────────────────────────────────────────────────

const mockPrisma = {
  tender: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    count: jest.fn(),
  },
  tenderBid: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    count: jest.fn(),
  },
  tenderCommission: {
    create: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn(),
  },
  projectRequirement: {
    create: jest.fn(),
    findUnique: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn(),
  },
  supplierOffer: {
    create: jest.fn(),
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
  $transaction: jest.fn(),
};

const mockCompanies = {
  getMyCompany: jest.fn(),
};

const mockEvents = { emit: jest.fn() };

const demoCompany = { id: 'co-1', ownerId: 'user-1' };
const futureDeadline = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
const demoTender = {
  id: 'tndr-1',
  companyId: 'co-1',
  company: { ownerId: 'user-1' },
  status: 'OPEN',
  title: 'Test Tender',
  deadline: futureDeadline,
  bids: [],
  requirements: [],
};
const demoBid = {
  id: 'bid-1',
  tenderId: 'tndr-1',
  companyId: 'co-1',
  amount: 1_000_000,
  status: 'PENDING',
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('TendersService', () => {
  let service: TendersService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TendersService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: CompaniesService, useValue: mockCompanies },
        { provide: EventEmitter2, useValue: mockEvents },
      ],
    }).compile();
    service = module.get<TendersService>(TendersService);
  });

  // ── list ───────────────────────────────────────────────────────────────────
  describe('list', () => {
    it('returns open tenders by default', async () => {
      mockPrisma.tender.findMany.mockResolvedValue([demoTender]);
      mockPrisma.tender.count.mockResolvedValue(1);
      const result = await service.list();
      expect(mockPrisma.tender.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ status: 'OPEN' }) }),
      );
      expect(result.items).toHaveLength(1);
      expect(result.total).toBe(1);
    });

    it('filters by status when provided', async () => {
      mockPrisma.tender.findMany.mockResolvedValue([]);
      mockPrisma.tender.count.mockResolvedValue(0);
      await service.list({ status: 'AWARDED' });
      expect(mockPrisma.tender.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ status: 'AWARDED' }) }),
      );
    });
  });

  // ── get ────────────────────────────────────────────────────────────────────
  describe('get', () => {
    it('throws NotFoundException for unknown tender', async () => {
      mockPrisma.tender.findUnique.mockResolvedValue(null);
      await expect(service.get('bad-id', 'user-1')).rejects.toThrow(NotFoundException);
    });

    it('returns full tender with bids and requirements', async () => {
      mockPrisma.tender.findUnique.mockResolvedValue(demoTender);
      const result = await service.get('tndr-1', 'user-1');
      expect(result.id).toBe('tndr-1');
    });
  });

  // ── award ──────────────────────────────────────────────────────────────────
  describe('award', () => {
    it('throws ForbiddenException when company does not own tender', async () => {
      mockPrisma.tender.findUnique.mockResolvedValue({
        ...demoTender,
        company: { ownerId: 'other-user' },
      });
      mockCompanies.getMyCompany.mockResolvedValue(demoCompany);
      await expect(service.award('tndr-1', 'bid-1', 'user-1')).rejects.toThrow(ForbiddenException);
    });

    it('throws BadRequestException when tender is not OPEN', async () => {
      mockPrisma.tender.findUnique.mockResolvedValue({ ...demoTender, status: 'AWARDED' });
      mockCompanies.getMyCompany.mockResolvedValue(demoCompany);
      await expect(service.award('tndr-1', 'bid-1', 'user-1')).rejects.toThrow(BadRequestException);
    });

    it('throws NotFoundException when bid not found', async () => {
      mockPrisma.tender.findUnique.mockResolvedValue(demoTender);
      mockCompanies.getMyCompany.mockResolvedValue(demoCompany);
      mockPrisma.tenderBid.findUnique.mockResolvedValue(null);
      await expect(service.award('tndr-1', 'bid-1', 'user-1')).rejects.toThrow(NotFoundException);
    });

    it('creates commission atomically and emits tender.awarded event', async () => {
      mockPrisma.tender.findUnique.mockResolvedValue(demoTender);
      mockCompanies.getMyCompany.mockResolvedValue(demoCompany);
      mockPrisma.tenderBid.findUnique.mockResolvedValue(demoBid);
      mockPrisma.$transaction.mockResolvedValue([]);

      const result = await service.award('tndr-1', 'bid-1', 'user-1');

      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
      expect(mockEvents.emit).toHaveBeenCalledWith(
        'tender.awarded',
        expect.objectContaining({ tenderId: 'tndr-1', winningBidId: 'bid-1' }),
      );
      expect(result.ok).toBe(true);
      // 2% commission on 1,000,000
      expect(result.commissionAmount).toBe(20_000);
    });
  });

  // ── submitBid ──────────────────────────────────────────────────────────────
  describe('submitBid', () => {
    it('throws BadRequestException when terms not accepted', async () => {
      await expect(
        service.submitBid('tndr-1', 'user-1', { amount: 500_000, termsAccepted: false }),
      ).rejects.toThrow(BadRequestException);
    });

    it('creates bid with companyId when company found', async () => {
      mockPrisma.tender.findUnique.mockResolvedValue(demoTender);
      mockCompanies.getMyCompany.mockResolvedValue({ id: 'co-2', ownerId: 'user-2' });
      mockPrisma.tenderBid.findFirst.mockResolvedValue(null);
      mockPrisma.tenderBid.create.mockResolvedValue({ ...demoBid, id: 'bid-2' });

      const result = await service.submitBid('tndr-1', 'user-2', {
        amount: 900_000,
        durationMonths: 12,
        termsAccepted: true,
      });

      expect(mockPrisma.tenderBid.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ companyId: 'co-2' }) }),
      );
      expect(result.id).toBe('bid-2');
    });

    it('creates bid with null companyId when no company', async () => {
      mockPrisma.tender.findUnique.mockResolvedValue(demoTender);
      mockCompanies.getMyCompany.mockRejectedValue(new Error('no company'));
      mockPrisma.tenderBid.findFirst.mockResolvedValue(null);
      mockPrisma.tenderBid.create.mockResolvedValue({ id: 'bid-3' });

      await service.submitBid('tndr-1', 'user-2', {
        amount: 800_000,
        durationMonths: 6,
        termsAccepted: true,
      });

      expect(mockPrisma.tenderBid.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ companyId: null }) }),
      );
    });
  });

  // ── selectOffer ────────────────────────────────────────────────────────────
  describe('selectOffer', () => {
    it('accepts one offer and rejects all others atomically', async () => {
      mockPrisma.projectRequirement.findUnique.mockResolvedValue({
        id: 'req-1',
        tender: { company: { ownerId: 'user-1' } },
      });
      mockPrisma.supplierOffer.findUnique.mockResolvedValue({
        id: 'offer-1',
        requirementId: 'req-1',
      });
      mockPrisma.$transaction.mockResolvedValue([]);
      const result = await service.selectOffer('offer-1', 'req-1', 'user-1');
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
      expect(result.ok).toBe(true);
    });
  });
});
