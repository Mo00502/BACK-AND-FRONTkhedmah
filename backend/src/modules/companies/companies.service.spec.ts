import { Test, TestingModule } from '@nestjs/testing';
import {
  NotFoundException,
  ForbiddenException,
  ConflictException,
} from '@nestjs/common';
import { CompaniesService } from './companies.service';
import { PrismaService } from '../../prisma/prisma.service';

const mockPrisma = {
  company: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
  tender: {
    count: jest.fn(),
  },
};

const makeCompany = (overrides: Partial<Record<string, any>> = {}) => ({
  id: 'company-1',
  ownerId: 'user-1',
  nameAr: 'شركة الاختبار',
  nameEn: 'Test Company',
  crNumber: 'CR-12345',
  city: 'Riyadh',
  logoUrl: null,
  phone: null,
  email: null,
  website: null,
  verified: false,
  ...overrides,
});

describe('CompaniesService', () => {
  let service: CompaniesService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CompaniesService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<CompaniesService>(CompaniesService);
  });

  // ── create ─────────────────────────────────────────────────────────────────
  describe('create', () => {
    const dto = {
      nameAr: 'شركة الاختبار',
      nameEn: 'Test Company',
      crNumber: 'CR-12345',
      city: 'Riyadh',
      logoUrl: undefined,
      phone: undefined,
      email: undefined,
      website: undefined,
    };

    it('creates a company when the CR number is unique', async () => {
      const company = makeCompany();
      mockPrisma.company.findUnique.mockResolvedValue(null); // no conflict
      mockPrisma.company.create.mockResolvedValue(company);

      const result = await service.create('user-1', dto);

      expect(mockPrisma.company.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ ownerId: 'user-1', crNumber: 'CR-12345' }) }),
      );
      expect(result).toBe(company);
    });

    it('throws ConflictException when CR number already exists', async () => {
      mockPrisma.company.findUnique.mockResolvedValue(makeCompany());

      await expect(service.create('user-2', dto)).rejects.toThrow(ConflictException);
      expect(mockPrisma.company.create).not.toHaveBeenCalled();
    });
  });

  // ── getMyCompany ───────────────────────────────────────────────────────────
  describe('getMyCompany', () => {
    it('returns the company owned by the given user', async () => {
      const company = makeCompany();
      mockPrisma.company.findFirst.mockResolvedValue(company);

      const result = await service.getMyCompany('user-1');

      expect(mockPrisma.company.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { ownerId: 'user-1' } }),
      );
      expect(result).toBe(company);
    });

    it('throws NotFoundException when user has no company', async () => {
      mockPrisma.company.findFirst.mockResolvedValue(null);

      await expect(service.getMyCompany('user-1')).rejects.toThrow(NotFoundException);
    });
  });

  // ── update ─────────────────────────────────────────────────────────────────
  describe('update', () => {
    const updateDto = { nameAr: 'شركة محدثة' };

    it('updates the company when called by the owner', async () => {
      const existing = makeCompany();
      const updated = makeCompany({ nameAr: 'شركة محدثة' });
      mockPrisma.company.findUnique.mockResolvedValue(existing);
      mockPrisma.company.update.mockResolvedValue(updated);

      const result = await service.update('company-1', 'user-1', updateDto);

      expect(mockPrisma.company.update).toHaveBeenCalledWith({
        where: { id: 'company-1' },
        data: updateDto,
      });
      expect(result).toBe(updated);
    });

    it('throws NotFoundException when company does not exist', async () => {
      mockPrisma.company.findUnique.mockResolvedValue(null);

      await expect(service.update('missing-id', 'user-1', updateDto)).rejects.toThrow(NotFoundException);
    });

    it('throws ForbiddenException when caller is not the owner', async () => {
      mockPrisma.company.findUnique.mockResolvedValue(makeCompany({ ownerId: 'owner-user' }));

      await expect(service.update('company-1', 'other-user', updateDto)).rejects.toThrow(ForbiddenException);
      expect(mockPrisma.company.update).not.toHaveBeenCalled();
    });

    it('throws ConflictException when updating to a CR number already used by another company', async () => {
      mockPrisma.company.findUnique
        .mockResolvedValueOnce(makeCompany({ crNumber: 'CR-OLD' }))   // company to update
        .mockResolvedValueOnce(makeCompany({ id: 'company-2', crNumber: 'CR-TAKEN' })); // conflict

      await expect(
        service.update('company-1', 'user-1', { crNumber: 'CR-TAKEN' }),
      ).rejects.toThrow(ConflictException);
    });
  });

  // ── getById ────────────────────────────────────────────────────────────────
  describe('getById', () => {
    it('returns a company by id', async () => {
      const company = makeCompany();
      mockPrisma.company.findUnique.mockResolvedValue(company);

      const result = await service.getById('company-1');

      expect(mockPrisma.company.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'company-1' } }),
      );
      expect(result).toBe(company);
    });

    it('throws NotFoundException when company does not exist', async () => {
      mockPrisma.company.findUnique.mockResolvedValue(null);

      await expect(service.getById('missing-id')).rejects.toThrow(NotFoundException);
    });
  });

  // ── delete ─────────────────────────────────────────────────────────────────
  describe('delete', () => {
    it('deletes company when owner calls and no active tenders exist', async () => {
      mockPrisma.company.findUnique.mockResolvedValue(makeCompany());
      mockPrisma.tender.count.mockResolvedValue(0);
      mockPrisma.company.delete.mockResolvedValue(makeCompany());

      const result = await service.delete('company-1', 'user-1');

      expect(mockPrisma.company.delete).toHaveBeenCalledWith({ where: { id: 'company-1' } });
      expect(result).toEqual({ message: 'Company deleted' });
    });

    it('throws NotFoundException when company does not exist', async () => {
      mockPrisma.company.findUnique.mockResolvedValue(null);

      await expect(service.delete('missing', 'user-1')).rejects.toThrow(NotFoundException);
    });

    it('throws ForbiddenException when non-owner tries to delete', async () => {
      mockPrisma.company.findUnique.mockResolvedValue(makeCompany({ ownerId: 'actual-owner' }));

      await expect(service.delete('company-1', 'intruder')).rejects.toThrow(ForbiddenException);
      expect(mockPrisma.company.delete).not.toHaveBeenCalled();
    });

    it('throws ConflictException when company has active tenders', async () => {
      mockPrisma.company.findUnique.mockResolvedValue(makeCompany());
      mockPrisma.tender.count.mockResolvedValue(2);

      await expect(service.delete('company-1', 'user-1')).rejects.toThrow(ConflictException);
      expect(mockPrisma.company.delete).not.toHaveBeenCalled();
    });
  });
});
