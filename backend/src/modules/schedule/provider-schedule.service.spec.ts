import { NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { ProviderScheduleService } from './provider-schedule.service';

const mockPrisma = {
  providerProfile: { findUnique: jest.fn() },
  providerSchedule: { findMany: jest.fn(), upsert: jest.fn(), findUnique: jest.fn() },
  providerVacation: {
    findUnique: jest.fn(),
    create: jest.fn(),
    delete: jest.fn(),
    findMany: jest.fn(),
    findFirst: jest.fn(),
  },
  $transaction: jest.fn(),
};

describe('ProviderScheduleService', () => {
  let service: ProviderScheduleService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new ProviderScheduleService(mockPrisma as any);
  });

  describe('getSchedule()', () => {
    it('returns all 7 days, filling missing days with defaults', async () => {
      // Only Monday in DB
      mockPrisma.providerSchedule.findMany.mockResolvedValue([
        { providerId: 'p1', dayOfWeek: 'MONDAY', startTime: '09:00', endTime: '17:00', isWorking: true },
      ]);

      const result = await service.getSchedule('p1');

      expect(result).toHaveLength(7);
      const monday = result.find((d) => d.dayOfWeek === 'MONDAY');
      expect(monday?.isWorking).toBe(true);
      const sunday = result.find((d) => d.dayOfWeek === 'SUNDAY');
      expect(sunday?.isWorking).toBe(false);
    });
  });

  describe('setDaySchedule()', () => {
    it('upserts the schedule for the owner', async () => {
      mockPrisma.providerProfile.findUnique.mockResolvedValue({ id: 'p1', userId: 'u1' });
      mockPrisma.providerSchedule.upsert.mockResolvedValue({ dayOfWeek: 'MONDAY' });

      await service.setDaySchedule('u1', 'p1', 'MONDAY', '08:00', '16:00', true);

      expect(mockPrisma.providerSchedule.upsert).toHaveBeenCalled();
    });

    it('throws ForbiddenException when userId does not own the profile', async () => {
      mockPrisma.providerProfile.findUnique.mockResolvedValue({ id: 'p1', userId: 'other' });

      await expect(
        service.setDaySchedule('u1', 'p1', 'MONDAY', '08:00', '16:00', true),
      ).rejects.toThrow(ForbiddenException);
    });

    it('throws NotFoundException when provider profile does not exist', async () => {
      mockPrisma.providerProfile.findUnique.mockResolvedValue(null);

      await expect(
        service.setDaySchedule('u1', 'bad', 'MONDAY', '08:00', '16:00', true),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException for invalid time format', async () => {
      mockPrisma.providerProfile.findUnique.mockResolvedValue({ id: 'p1', userId: 'u1' });

      await expect(
        service.setDaySchedule('u1', 'p1', 'MONDAY', '8:00', '16:00', true),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when startTime is not before endTime', async () => {
      mockPrisma.providerProfile.findUnique.mockResolvedValue({ id: 'p1', userId: 'u1' });

      await expect(
        service.setDaySchedule('u1', 'p1', 'MONDAY', '18:00', '08:00', true),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('addVacation()', () => {
    it('creates vacation when dates are valid', async () => {
      mockPrisma.providerProfile.findUnique.mockResolvedValue({ id: 'p1', userId: 'u1' });
      const start = new Date('2026-04-01');
      const end = new Date('2026-04-10');
      mockPrisma.providerVacation.create.mockResolvedValue({ id: 'v1' });

      const result = await service.addVacation('u1', 'p1', start, end);

      expect(mockPrisma.providerVacation.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ startDate: start, endDate: end }) }),
      );
      expect(result).toEqual({ id: 'v1' });
    });

    it('throws BadRequestException when end is before start', async () => {
      mockPrisma.providerProfile.findUnique.mockResolvedValue({ id: 'p1', userId: 'u1' });
      const start = new Date('2026-04-10');
      const end = new Date('2026-04-01');

      await expect(service.addVacation('u1', 'p1', start, end)).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when start equals end', async () => {
      mockPrisma.providerProfile.findUnique.mockResolvedValue({ id: 'p1', userId: 'u1' });
      const date = new Date('2026-04-01');

      await expect(service.addVacation('u1', 'p1', date, date)).rejects.toThrow(BadRequestException);
    });
  });
});
