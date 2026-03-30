import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { AddressesService } from './addresses.service';

// ── Mock Prisma client ────────────────────────────────────────────────────────

const mockTx = {
  savedAddress: {
    updateMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
};

const mockPrisma = {
  savedAddress: {
    findMany: jest.fn(),
    count: jest.fn(),
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    delete: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
  $transaction: jest.fn((cb: (tx: typeof mockTx) => Promise<any>) => cb(mockTx)),
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const makeAddress = (overrides: Partial<Record<string, any>> = {}) => ({
  id: 'addr-1',
  userId: 'user-1',
  label: 'المنزل',
  city: 'الرياض',
  district: 'العليا',
  street: null,
  buildingNo: null,
  notes: null,
  lat: null,
  lng: null,
  isDefault: false,
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
  ...overrides,
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('AddressesService', () => {
  let service: AddressesService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AddressesService(mockPrisma as any);
  });

  // ── list() ──────────────────────────────────────────────────────────────────

  describe('list()', () => {
    it('returns addresses ordered by isDefault desc then createdAt desc', async () => {
      const addresses = [makeAddress({ isDefault: true }), makeAddress({ id: 'addr-2' })];
      mockPrisma.savedAddress.findMany.mockResolvedValue(addresses);

      const result = await service.list('user-1');

      expect(mockPrisma.savedAddress.findMany).toHaveBeenCalledWith({
        where: { userId: 'user-1' },
        orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
      });
      expect(result).toBe(addresses);
    });

    it('returns an empty array when user has no saved addresses', async () => {
      mockPrisma.savedAddress.findMany.mockResolvedValue([]);

      const result = await service.list('user-99');
      expect(result).toEqual([]);
    });
  });

  // ── create() ────────────────────────────────────────────────────────────────

  describe('create()', () => {
    const dto = { label: 'المنزل', city: 'الرياض', district: 'العليا' };

    it('creates address and marks it as default when it is the first address', async () => {
      mockPrisma.savedAddress.count.mockResolvedValue(0);
      const created = makeAddress({ isDefault: true });
      mockTx.savedAddress.create.mockResolvedValue(created);

      const result = await service.create('user-1', dto as any);

      expect(mockTx.savedAddress.updateMany).toHaveBeenCalledWith({
        where: { userId: 'user-1', isDefault: true },
        data: { isDefault: false },
      });
      expect(mockTx.savedAddress.create).toHaveBeenCalledWith({
        data: { ...dto, userId: 'user-1', isDefault: true },
      });
      expect(result).toBe(created);
    });

    it('clears existing defaults when isDefault=true is explicitly requested', async () => {
      mockPrisma.savedAddress.count.mockResolvedValue(3);
      const created = makeAddress({ isDefault: true });
      mockTx.savedAddress.create.mockResolvedValue(created);

      await service.create('user-1', { ...dto, isDefault: true } as any);

      expect(mockTx.savedAddress.updateMany).toHaveBeenCalledWith({
        where: { userId: 'user-1', isDefault: true },
        data: { isDefault: false },
      });
    });

    it('does NOT clear defaults when isDefault is omitted and user already has addresses', async () => {
      mockPrisma.savedAddress.count.mockResolvedValue(2);
      const created = makeAddress({ isDefault: false });
      mockTx.savedAddress.create.mockResolvedValue(created);

      await service.create('user-1', dto as any);

      // updateMany should not be called because count > 0 and isDefault is falsy
      expect(mockTx.savedAddress.updateMany).not.toHaveBeenCalled();
      expect(mockTx.savedAddress.create).toHaveBeenCalledWith({
        data: { ...dto, userId: 'user-1', isDefault: false },
      });
    });

    it('throws BadRequestException when user already has 10 addresses', async () => {
      mockPrisma.savedAddress.count.mockResolvedValue(10);

      await expect(service.create('user-1', dto as any)).rejects.toThrow(BadRequestException);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });
  });

  // ── update() ────────────────────────────────────────────────────────────────

  describe('update()', () => {
    it('throws NotFoundException when address does not exist', async () => {
      mockPrisma.savedAddress.findUnique.mockResolvedValue(null);

      await expect(service.update('user-1', 'addr-x', {} as any)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws ForbiddenException when address belongs to a different user', async () => {
      mockPrisma.savedAddress.findUnique.mockResolvedValue(makeAddress({ userId: 'user-other' }));

      await expect(service.update('user-1', 'addr-1', {} as any)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('clears old defaults when isDefault=true is set during update', async () => {
      mockPrisma.savedAddress.findUnique.mockResolvedValue(makeAddress());
      const updated = makeAddress({ isDefault: true });
      mockTx.savedAddress.update.mockResolvedValue(updated);

      const result = await service.update('user-1', 'addr-1', { isDefault: true } as any);

      expect(mockTx.savedAddress.updateMany).toHaveBeenCalledWith({
        where: { userId: 'user-1', isDefault: true },
        data: { isDefault: false },
      });
      expect(mockTx.savedAddress.update).toHaveBeenCalledWith({
        where: { id: 'addr-1' },
        data: { isDefault: true },
      });
      expect(result).toBe(updated);
    });

    it('does NOT clear defaults when isDefault is not being set', async () => {
      mockPrisma.savedAddress.findUnique.mockResolvedValue(makeAddress());
      mockTx.savedAddress.update.mockResolvedValue(makeAddress({ label: 'المكتب' }));

      await service.update('user-1', 'addr-1', { label: 'المكتب' } as any);

      expect(mockTx.savedAddress.updateMany).not.toHaveBeenCalled();
    });
  });

  // ── remove() ────────────────────────────────────────────────────────────────

  describe('remove()', () => {
    it('throws NotFoundException when address does not exist', async () => {
      mockPrisma.savedAddress.findUnique.mockResolvedValue(null);

      await expect(service.remove('user-1', 'addr-x')).rejects.toThrow(NotFoundException);
    });

    it('throws ForbiddenException when address belongs to a different user', async () => {
      mockPrisma.savedAddress.findUnique.mockResolvedValue(makeAddress({ userId: 'user-other' }));

      await expect(service.remove('user-1', 'addr-1')).rejects.toThrow(ForbiddenException);
    });

    it('deletes the address and returns { success: true }', async () => {
      mockPrisma.savedAddress.findUnique.mockResolvedValue(makeAddress({ isDefault: false }));
      mockPrisma.savedAddress.delete.mockResolvedValue(makeAddress());

      const result = await service.remove('user-1', 'addr-1');

      expect(mockPrisma.savedAddress.delete).toHaveBeenCalledWith({ where: { id: 'addr-1' } });
      expect(result).toEqual({ success: true });
    });

    it('auto-promotes the most recent remaining address to default when default is deleted', async () => {
      mockPrisma.savedAddress.findUnique.mockResolvedValue(makeAddress({ isDefault: true }));
      mockPrisma.savedAddress.delete.mockResolvedValue(makeAddress());
      const nextAddr = makeAddress({ id: 'addr-2', isDefault: false });
      mockPrisma.savedAddress.findFirst.mockResolvedValue(nextAddr);
      mockPrisma.savedAddress.update.mockResolvedValue({ ...nextAddr, isDefault: true });

      await service.remove('user-1', 'addr-1');

      expect(mockPrisma.savedAddress.findFirst).toHaveBeenCalledWith({
        where: { userId: 'user-1' },
        orderBy: { createdAt: 'desc' },
      });
      expect(mockPrisma.savedAddress.update).toHaveBeenCalledWith({
        where: { id: 'addr-2' },
        data: { isDefault: true },
      });
    });

    it('does NOT attempt promotion when no remaining addresses exist after deletion', async () => {
      mockPrisma.savedAddress.findUnique.mockResolvedValue(makeAddress({ isDefault: true }));
      mockPrisma.savedAddress.delete.mockResolvedValue(makeAddress());
      mockPrisma.savedAddress.findFirst.mockResolvedValue(null);

      await service.remove('user-1', 'addr-1');

      expect(mockPrisma.savedAddress.update).not.toHaveBeenCalled();
    });

    it('skips promotion entirely when deleted address was NOT the default', async () => {
      mockPrisma.savedAddress.findUnique.mockResolvedValue(makeAddress({ isDefault: false }));
      mockPrisma.savedAddress.delete.mockResolvedValue(makeAddress());

      await service.remove('user-1', 'addr-1');

      expect(mockPrisma.savedAddress.findFirst).not.toHaveBeenCalled();
      expect(mockPrisma.savedAddress.update).not.toHaveBeenCalled();
    });
  });

  // ── setDefault() ─────────────────────────────────────────────────────────────

  describe('setDefault()', () => {
    it('throws NotFoundException when address does not exist', async () => {
      mockPrisma.savedAddress.findUnique.mockResolvedValue(null);

      await expect(service.setDefault('user-1', 'addr-x')).rejects.toThrow(NotFoundException);
    });

    it('throws ForbiddenException when address belongs to a different user', async () => {
      mockPrisma.savedAddress.findUnique.mockResolvedValue(makeAddress({ userId: 'user-other' }));

      await expect(service.setDefault('user-1', 'addr-1')).rejects.toThrow(ForbiddenException);
    });

    it('clears all existing defaults then marks the target address as default', async () => {
      mockPrisma.savedAddress.findUnique.mockResolvedValue(makeAddress());
      const updated = makeAddress({ isDefault: true });
      mockTx.savedAddress.update.mockResolvedValue(updated);

      const result = await service.setDefault('user-1', 'addr-1');

      expect(mockTx.savedAddress.updateMany).toHaveBeenCalledWith({
        where: { userId: 'user-1', isDefault: true },
        data: { isDefault: false },
      });
      expect(mockTx.savedAddress.update).toHaveBeenCalledWith({
        where: { id: 'addr-1' },
        data: { isDefault: true },
      });
      expect(result).toBe(updated);
    });
  });
});
