import { Test, TestingModule } from '@nestjs/testing';
import { InvoicesService } from './invoices.service';
import { PrismaService } from '../../prisma/prisma.service';
import { NotFoundException, ForbiddenException } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';

const mockPrisma = {
  serviceRequest: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
  },
  tenderCommission: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
  },
  equipmentRental: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
  },
  consultation: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
  },
};

describe('InvoicesService', () => {
  let service: InvoicesService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvoicesService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();
    service = module.get<InvoicesService>(InvoicesService);
  });

  // ── getServiceInvoice ────────────────────────────────────────────────────
  describe('getServiceInvoice', () => {
    const makeRequest = (customerId: string, providerId: string, quoteAmount: number) => ({
      id: '12345678-abcd-efgh',
      customerId,
      providerId,
      customer: { id: customerId, profile: { nameAr: 'أحمد' } },
      provider: { id: providerId, profile: { nameAr: 'خالد' }, providerProfile: {} },
      service: { nameAr: 'سباكة' },
      quotes: [{ amount: new Decimal(quoteAmount), status: 'ACCEPTED' }],
      escrow: { id: 'escrow-1', releasedAt: new Date('2025-01-01'), status: 'RELEASED' },
      payments: [{ method: 'CARD', status: 'PAID' }],
    });

    it('returns invoice with correct VAT calculation for the customer', async () => {
      const request = makeRequest('cust-1', 'prov-1', 1000);
      mockPrisma.serviceRequest.findUnique.mockResolvedValue(request);

      const result = await service.getServiceInvoice('cust-1', 'req-1') as any;

      expect(result.subtotal).toBe(1000);
      expect(result.vat).toBe(150); // 15% of 1000
      expect(result.total).toBe(1150);
      expect(result.invoiceType).toBe('HOME_SERVICE');
      expect(result.currency).toBe('SAR');
      expect(result.vatRate).toBe('15%');
      expect(result.status).toBe('PAID');
    });

    it('allows the provider to view the invoice', async () => {
      const request = makeRequest('cust-1', 'prov-1', 500);
      mockPrisma.serviceRequest.findUnique.mockResolvedValue(request);

      const result = await service.getServiceInvoice('prov-1', 'req-1') as any;

      expect(result.subtotal).toBe(500);
    });

    it('throws NotFoundException when request does not exist', async () => {
      mockPrisma.serviceRequest.findUnique.mockResolvedValue(null);
      await expect(service.getServiceInvoice('cust-1', 'non-existent')).rejects.toThrow(NotFoundException);
    });

    it('throws ForbiddenException when userId is neither customer nor provider', async () => {
      const request = makeRequest('cust-1', 'prov-1', 1000);
      mockPrisma.serviceRequest.findUnique.mockResolvedValue(request);

      await expect(service.getServiceInvoice('stranger-99', 'req-1')).rejects.toThrow(ForbiddenException);
    });

    it('sets invoiceRef to HS- prefix with first 8 chars of requestId uppercased', async () => {
      const request = makeRequest('cust-1', 'prov-1', 200);
      request.id = 'abcdef12-xxxx';
      mockPrisma.serviceRequest.findUnique.mockResolvedValue(request);

      const result = await service.getServiceInvoice('cust-1', 'abcdef12-xxxx') as any;

      expect(result.invoiceRef).toBe('HS-ABCDEF12');
    });

    it('handles zero-amount quote gracefully (defaults to 0)', async () => {
      const request = makeRequest('cust-1', 'prov-1', 0);
      request.quotes = []; // no accepted quote
      mockPrisma.serviceRequest.findUnique.mockResolvedValue(request);

      const result = await service.getServiceInvoice('cust-1', 'req-1') as any;

      expect(result.subtotal).toBe(0);
      expect(result.vat).toBe(0);
      expect(result.total).toBe(0);
    });
  });

  // ── getTenderCommissionInvoice ───────────────────────────────────────────
  describe('getTenderCommissionInvoice', () => {
    const makeCommission = (winnerOwnerId: string, awardingOwnerId: string) => ({
      id: '12345678-comm',
      commissionAmount: new Decimal('200.00'),
      tenderValue: new Decimal('10000.00'),
      commissionRate: new Decimal('0.02'),
      paidAt: new Date('2025-02-01'),
      tender: {
        title: 'مناقصة بناء',
        company: { ownerId: awardingOwnerId, owner: { profile: { nameAr: 'شركة أ' } } },
      },
      company: {
        ownerId: winnerOwnerId,
        owner: { profile: { nameAr: 'شركة ب' } },
      },
    });

    it('returns invoice for the winning company owner', async () => {
      mockPrisma.tenderCommission.findUnique.mockResolvedValue(makeCommission('winner-1', 'awarding-1'));

      const result = await service.getTenderCommissionInvoice('winner-1', 'comm-1') as any;

      expect(result.invoiceType).toBe('TENDER_COMMISSION');
      expect(result.subtotal).toBe(200);
      expect(result.vat).toBe(30); // 15% of 200
      expect(result.total).toBe(230);
    });

    it('returns invoice for the awarding company owner', async () => {
      mockPrisma.tenderCommission.findUnique.mockResolvedValue(makeCommission('winner-1', 'awarding-1'));

      const result = await service.getTenderCommissionInvoice('awarding-1', 'comm-1') as any;

      expect(result.invoiceType).toBe('TENDER_COMMISSION');
    });

    it('throws NotFoundException when commission does not exist', async () => {
      mockPrisma.tenderCommission.findUnique.mockResolvedValue(null);
      await expect(service.getTenderCommissionInvoice('user-1', 'non-existent')).rejects.toThrow(NotFoundException);
    });

    it('throws ForbiddenException for an unrelated user', async () => {
      mockPrisma.tenderCommission.findUnique.mockResolvedValue(makeCommission('winner-1', 'awarding-1'));
      await expect(service.getTenderCommissionInvoice('stranger-99', 'comm-1')).rejects.toThrow(ForbiddenException);
    });
  });

  // ── listMyInvoices ───────────────────────────────────────────────────────
  describe('listMyInvoices', () => {
    beforeEach(() => {
      // Provide empty default responses so each test only overrides what it needs
      mockPrisma.serviceRequest.findMany.mockResolvedValue([]);
      mockPrisma.tenderCommission.findMany.mockResolvedValue([]);
      mockPrisma.equipmentRental.findMany.mockResolvedValue([]);
      mockPrisma.consultation.findMany.mockResolvedValue([]);
    });

    it('merges all invoice types and returns paginated result', async () => {
      const now = new Date();
      mockPrisma.serviceRequest.findMany.mockResolvedValue([
        { id: 'req-1', service: { nameAr: 'سباكة' }, completedAt: new Date(now.getTime() - 1000) },
      ]);
      mockPrisma.tenderCommission.findMany.mockResolvedValue([
        { id: 'comm-1', tender: { title: 'مناقصة' }, commissionAmount: new Decimal('500'), paidAt: now },
      ]);

      const result = await service.listMyInvoices('user-1', 1, 20);

      expect(result.total).toBe(2);
      expect(result.data).toHaveLength(2);
      // Most recent first — tender commission (paidAt = now) should be first
      expect(result.data[0].type).toBe('TENDER_COMMISSION');
      expect(result.data[1].type).toBe('HOME_SERVICE');
    });

    it('paginates correctly: page 2 returns second slice', async () => {
      // 5 service requests
      const requests = Array.from({ length: 5 }, (_, i) => ({
        id: `req-${i}`,
        service: { nameAr: 'خدمة' },
        completedAt: new Date(Date.now() - i * 1000),
      }));
      mockPrisma.serviceRequest.findMany.mockResolvedValue(requests);

      const result = await service.listMyInvoices('user-1', 2, 2);

      expect(result.page).toBe(2);
      expect(result.data).toHaveLength(2);
      expect(result.total).toBe(5);
      expect(result.pages).toBe(3);
    });

    it('returns empty result when user has no invoices', async () => {
      const result = await service.listMyInvoices('user-no-invoices', 1, 20);

      expect(result.total).toBe(0);
      expect(result.data).toHaveLength(0);
      expect(result.pages).toBe(0);
    });

    it('correctly formats invoice refs with type prefixes', async () => {
      mockPrisma.serviceRequest.findMany.mockResolvedValue([
        { id: 'abcdef12-rest', service: { nameAr: 'كهرباء' }, completedAt: new Date() },
      ]);

      const result = await service.listMyInvoices('user-1', 1, 20);

      expect(result.data[0].ref).toBe('HS-ABCDEF12');
      expect(result.data[0].type).toBe('HOME_SERVICE');
    });
  });

  // ── getConsultationInvoice ───────────────────────────────────────────────
  describe('getConsultationInvoice', () => {
    const makeConsultation = (customerId: string, providerId: string) => ({
      id: '12345678-cons',
      customerId,
      providerId,
      topic: 'استشارة قانونية',
      mode: 'VIDEO',
      totalAmount: new Decimal('300.00'),
      completedAt: new Date('2025-03-01'),
      customer: { id: customerId, profile: { nameAr: 'محمد' } },
      provider: { id: providerId, profile: { nameAr: 'سلمى' } },
      service: { nameAr: 'استشارات قانونية' },
    });

    it('returns consultation invoice with correct VAT for customer', async () => {
      mockPrisma.consultation.findUnique.mockResolvedValue(makeConsultation('cust-1', 'prov-1'));

      const result = await service.getConsultationInvoice('cons-1', 'cust-1') as any;

      expect(result.invoiceType).toBe('CONSULTATION');
      expect(result.subtotal).toBe(300);
      expect(result.vat).toBe(45); // 15% of 300
      expect(result.total).toBe(345);
    });

    it('throws NotFoundException when consultation does not exist', async () => {
      mockPrisma.consultation.findUnique.mockResolvedValue(null);
      await expect(service.getConsultationInvoice('non-existent', 'user-1')).rejects.toThrow(NotFoundException);
    });

    it('throws ForbiddenException for unrelated user', async () => {
      mockPrisma.consultation.findUnique.mockResolvedValue(makeConsultation('cust-1', 'prov-1'));
      await expect(service.getConsultationInvoice('cons-1', 'stranger-99')).rejects.toThrow(ForbiddenException);
    });
  });
});
