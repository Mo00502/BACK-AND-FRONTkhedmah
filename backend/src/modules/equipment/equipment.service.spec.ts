import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, ForbiddenException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { EquipmentService } from './equipment.service';
import { PrismaService } from '../../prisma/prisma.service';

// ── Mock factories ────────────────────────────────────────────────────────────

const mockEquipment = (overrides: Partial<any> = {}) => ({
  id: 'eq-1',
  ownerId: 'owner-1',
  name: 'رافعة شوكية',
  category: 'HEAVY_MACHINERY',
  region: 'الرياض',
  dayPrice: 500,
  isAvailable: true,
  status: 'ACTIVE',
  rentals: [],
  ...overrides,
});

const mockRental = (overrides: Partial<any> = {}) => ({
  id: 'rent-1',
  equipmentId: 'eq-1',
  renterId: 'renter-1',
  status: 'PENDING',
  equipment: mockEquipment(),
  ...overrides,
});

const buildPrismaMock = () => ({
  equipment: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    count: jest.fn(),
  },
  equipmentRental: {
    create: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
    findMany: jest.fn(),
  },
  $transaction: jest.fn().mockImplementation(async (fn: any) => {
    const tx = {
      equipment: { updateMany: jest.fn().mockResolvedValue({ count: 1 }), create: jest.fn() },
      equipmentRental: { create: jest.fn() },
    };
    return fn(tx);
  }),
});

// ── Test suite ────────────────────────────────────────────────────────────────

describe('EquipmentService', () => {
  let service: EquipmentService;
  let prisma: ReturnType<typeof buildPrismaMock>;
  let emitter: jest.Mocked<EventEmitter2>;

  beforeEach(async () => {
    prisma = buildPrismaMock();
    emitter = { emit: jest.fn() } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EquipmentService,
        { provide: PrismaService, useValue: prisma },
        { provide: EventEmitter2, useValue: emitter },
      ],
    }).compile();

    service = module.get(EquipmentService);
  });

  // ── 1. search ───────────────────────────────────────────────────────────────
  describe('search', () => {
    it('should return all active equipment when no filters provided', async () => {
      const list = [mockEquipment()];
      prisma.equipment.findMany.mockResolvedValue(list);
      prisma.equipment.count.mockResolvedValue(1);

      const result = await service.search();

      expect(prisma.equipment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ status: 'ACTIVE' }) }),
      );
      expect(result.items).toEqual(list);
      expect(result.total).toBe(1);
    });

    it('should pass region and text filters to prisma', async () => {
      prisma.equipment.findMany.mockResolvedValue([]);
      prisma.equipment.count.mockResolvedValue(0);

      await service.search({ region: 'جدة', q: 'رافعة' });

      expect(prisma.equipment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            region: 'جدة',
            OR: expect.arrayContaining([
              expect.objectContaining({ name: { contains: 'رافعة', mode: 'insensitive' } }),
            ]),
          }),
        }),
      );
    });
  });

  // ── 2. get ──────────────────────────────────────────────────────────────────
  describe('get', () => {
    it('should return equipment with active rentals', async () => {
      const eq = mockEquipment({ rentals: [{ id: 'r1', status: 'CONFIRMED' }] });
      prisma.equipment.findUnique.mockResolvedValue(eq);

      const result = await service.get('eq-1');
      expect(result).toEqual(eq);
    });

    it('should throw NotFoundException when equipment does not exist', async () => {
      prisma.equipment.findUnique.mockResolvedValue(null);
      await expect(service.get('missing')).rejects.toThrow(NotFoundException);
    });
  });

  // ── 3. create ───────────────────────────────────────────────────────────────
  describe('create', () => {
    it('should create equipment with PENDING status and isAvailable=true', async () => {
      const eq = mockEquipment({ status: 'PENDING' });
      prisma.equipment.create.mockResolvedValue(eq);

      const result = await service.create('owner-1', { name: 'رافعة', dayPrice: 400 });

      expect(prisma.equipment.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ ownerId: 'owner-1', status: 'PENDING', isAvailable: true }),
      });
      expect(result.status).toBe('PENDING');
    });
  });

  // ── 4. update ───────────────────────────────────────────────────────────────
  describe('update', () => {
    it('should update equipment when caller is the owner', async () => {
      const eq = mockEquipment();
      const updated = { ...eq, dayPrice: 600 };
      prisma.equipment.findUnique.mockResolvedValue(eq);
      prisma.equipment.update.mockResolvedValue(updated);

      const result = await service.update('eq-1', 'owner-1', { dayPrice: 600 });
      expect(result.dayPrice).toBe(600);
    });

    it('should throw ForbiddenException when a non-owner tries to update', async () => {
      prisma.equipment.findUnique.mockResolvedValue(mockEquipment({ ownerId: 'owner-1' }));
      await expect(service.update('eq-1', 'other-user', {})).rejects.toThrow(ForbiddenException);
    });

    it('should throw NotFoundException when equipment does not exist', async () => {
      prisma.equipment.findUnique.mockResolvedValue(null);
      await expect(service.update('missing', 'owner-1', {})).rejects.toThrow(NotFoundException);
    });
  });

  // ── 5. remove ───────────────────────────────────────────────────────────────
  describe('remove', () => {
    it('should archive equipment (soft-delete) when owner calls remove', async () => {
      const archived = mockEquipment({ status: 'ARCHIVED' });
      prisma.equipment.findUnique.mockResolvedValue(mockEquipment());
      prisma.equipment.update.mockResolvedValue(archived);

      const result = await service.remove('eq-1', 'owner-1');
      expect(prisma.equipment.update).toHaveBeenCalledWith({
        where: { id: 'eq-1' },
        data: { status: 'ARCHIVED' },
      });
      expect(result.status).toBe('ARCHIVED');
    });
  });

  // ── 6. createRental ─────────────────────────────────────────────────────────
  describe('createRental', () => {
    it('should create rental, mark equipment unavailable, and emit event', async () => {
      const eq = mockEquipment();
      const rental = mockRental();
      prisma.equipment.findUnique.mockResolvedValue(eq);

      // Override $transaction to return the rental from equipmentRental.create
      (prisma.$transaction as jest.Mock).mockImplementationOnce(async (fn: any) => {
        const tx = {
          equipment: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
          equipmentRental: { create: jest.fn().mockResolvedValue(rental) },
        };
        return fn(tx);
      });

      const result = await service.createRental('eq-1', 'renter-1', {
        startDate: new Date(),
        endDate: new Date(),
      });

      expect(emitter.emit).toHaveBeenCalledWith(
        'equipment.booked',
        expect.objectContaining({
          equipmentId: 'eq-1',
          renterId: 'renter-1',
        }),
      );
      expect(result.status).toBe('PENDING');
    });
  });

  // ── 7. updateRentalStatus ───────────────────────────────────────────────────
  describe('updateRentalStatus', () => {
    it('should set completedAt and mark equipment available again on COMPLETED', async () => {
      const rental = mockRental({ status: 'ACTIVE' });
      const updated = { ...rental, status: 'COMPLETED', completedAt: new Date() };
      prisma.equipmentRental.findUnique.mockResolvedValue(rental);
      prisma.equipmentRental.update.mockResolvedValue(updated);
      prisma.equipment.update.mockResolvedValue(mockEquipment());

      await service.updateRentalStatus('rent-1', 'COMPLETED', 'owner-1');

      expect(prisma.equipment.update).toHaveBeenCalledWith({
        where: { id: 'eq-1' },
        data: { isAvailable: true, rentalCount: { increment: 1 } },
      });
      expect(emitter.emit).toHaveBeenCalledWith(
        'equipment.rental.status_changed',
        expect.objectContaining({ status: 'COMPLETED' }),
      );
    });

    it('should throw NotFoundException for unknown rental id', async () => {
      prisma.equipmentRental.findUnique.mockResolvedValue(null);
      await expect(service.updateRentalStatus('bad-id', 'CONFIRMED', 'uid')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ── 8. myRentals ────────────────────────────────────────────────────────────
  describe('myRentals', () => {
    it('should return rentals with equipment details for the renter', async () => {
      const rentals = [mockRental()];
      prisma.equipmentRental.findMany.mockResolvedValue(rentals);

      const result = await service.myRentals('renter-1');

      expect(prisma.equipmentRental.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { renterId: 'renter-1' } }),
      );
      expect(result).toEqual(rentals);
    });
  });
});
