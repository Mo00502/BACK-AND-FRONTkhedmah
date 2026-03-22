import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DisputesService } from './disputes.service';
import { PrismaService } from '../../prisma/prisma.service';

// ── Mock factories ────────────────────────────────────────────────────────────

const mockRequest = (overrides: Partial<any> = {}) => ({
  id: 'req-1',
  customerId: 'cust-1',
  providerId: 'prov-1',
  status: 'COMPLETED',
  ...overrides,
});

const mockDispute = (overrides: Partial<any> = {}) => ({
  id: 'disp-1',
  reporterId: 'cust-1',
  againstId: 'prov-1',
  requestId: 'req-1',
  reason: 'عدم إتمام العمل',
  status: 'OPEN',
  evidence: [],
  ...overrides,
});

const buildPrismaMock = () => ({
  serviceRequest: { findUnique: jest.fn() },
  dispute: {
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
});

// ── Test suite ────────────────────────────────────────────────────────────────

describe('DisputesService', () => {
  let service: DisputesService;
  let prisma: ReturnType<typeof buildPrismaMock>;
  let emitter: jest.Mocked<EventEmitter2>;

  beforeEach(async () => {
    prisma = buildPrismaMock();
    emitter = { emit: jest.fn() } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DisputesService,
        { provide: PrismaService, useValue: prisma },
        { provide: EventEmitter2, useValue: emitter },
      ],
    }).compile();

    service = module.get(DisputesService);
  });

  // ── openDispute ─────────────────────────────────────────────────────────────
  describe('openDispute', () => {
    it('should create a dispute and emit event when valid', async () => {
      const req = mockRequest();
      const dispute = mockDispute();
      prisma.serviceRequest.findUnique.mockResolvedValue(req);
      prisma.dispute.findFirst.mockResolvedValue(null);
      prisma.dispute.create.mockResolvedValue(dispute);

      const result = await service.openDispute('cust-1', 'req-1', 'عدم إتمام العمل');

      expect(prisma.dispute.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ reporterId: 'cust-1', againstId: 'prov-1' }),
        }),
      );
      expect(emitter.emit).toHaveBeenCalledWith(
        'dispute.opened',
        expect.objectContaining({
          disputeId: 'disp-1',
        }),
      );
      expect(result.id).toBe('disp-1');
    });

    it('should throw NotFoundException when request does not exist', async () => {
      prisma.serviceRequest.findUnique.mockResolvedValue(null);
      await expect(service.openDispute('cust-1', 'missing', 'reason')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw ForbiddenException when reporter is not a participant', async () => {
      prisma.serviceRequest.findUnique.mockResolvedValue(mockRequest());
      await expect(service.openDispute('stranger', 'req-1', 'reason')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('should throw BadRequestException when request status is PENDING', async () => {
      prisma.serviceRequest.findUnique.mockResolvedValue(mockRequest({ status: 'PENDING' }));
      await expect(service.openDispute('cust-1', 'req-1', 'reason')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException when an open dispute already exists', async () => {
      prisma.serviceRequest.findUnique.mockResolvedValue(mockRequest());
      prisma.dispute.findFirst.mockResolvedValue(mockDispute());
      await expect(service.openDispute('cust-1', 'req-1', 'reason')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should correctly set againstId to customer when provider opens dispute', async () => {
      const req = mockRequest();
      const dispute = mockDispute({ reporterId: 'prov-1', againstId: 'cust-1' });
      prisma.serviceRequest.findUnique.mockResolvedValue(req);
      prisma.dispute.findFirst.mockResolvedValue(null);
      prisma.dispute.create.mockResolvedValue(dispute);

      const result = await service.openDispute('prov-1', 'req-1', 'عدم الدفع');
      expect(prisma.dispute.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ reporterId: 'prov-1', againstId: 'cust-1' }),
        }),
      );
    });
  });

  // ── addEvidence ─────────────────────────────────────────────────────────────
  describe('addEvidence', () => {
    it('should push new file URLs to evidence array', async () => {
      prisma.dispute.findUnique.mockResolvedValue(mockDispute());
      prisma.dispute.update.mockResolvedValue(mockDispute({ evidence: ['url1.jpg'] }));

      await service.addEvidence('cust-1', 'disp-1', ['url1.jpg']);

      expect(prisma.dispute.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { evidence: { push: ['url1.jpg'] } } }),
      );
    });

    it('should allow defendant (againstId) to add defensive evidence', async () => {
      // Bug fix: both reporter AND defendant can add evidence (prov-1 is againstId in mockDispute)
      prisma.dispute.findUnique.mockResolvedValue(
        mockDispute({ reporterId: 'cust-1', againstId: 'prov-1' }),
      );
      prisma.dispute.update.mockResolvedValue(mockDispute({ evidence: ['defense.jpg'] }));
      // Should NOT throw — defendant has the right to add their defense
      await expect(service.addEvidence('prov-1', 'disp-1', ['defense.jpg'])).resolves.toBeDefined();
    });

    it('should throw ForbiddenException if uninvolved third party tries to add evidence', async () => {
      prisma.dispute.findUnique.mockResolvedValue(
        mockDispute({ reporterId: 'cust-1', againstId: 'prov-1' }),
      );
      await expect(service.addEvidence('stranger-id', 'disp-1', ['url.jpg'])).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('should throw BadRequestException if dispute is not OPEN', async () => {
      prisma.dispute.findUnique.mockResolvedValue(mockDispute({ status: 'RESOLVED' }));
      await expect(service.addEvidence('cust-1', 'disp-1', ['url.jpg'])).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  // ── escalate ────────────────────────────────────────────────────────────────
  describe('escalate', () => {
    it('should change status to UNDER_REVIEW', async () => {
      prisma.dispute.findUnique.mockResolvedValue(mockDispute());
      prisma.dispute.update.mockResolvedValue(mockDispute({ status: 'UNDER_REVIEW' }));

      const result = await service.escalate('cust-1', 'disp-1');
      expect(prisma.dispute.update).toHaveBeenCalledWith({
        where: { id: 'disp-1' },
        data: { status: 'UNDER_REVIEW' },
      });
    });

    it('should throw BadRequestException if dispute is already UNDER_REVIEW', async () => {
      prisma.dispute.findUnique.mockResolvedValue(mockDispute({ status: 'UNDER_REVIEW' }));
      await expect(service.escalate('cust-1', 'disp-1')).rejects.toThrow(BadRequestException);
    });
  });
});
