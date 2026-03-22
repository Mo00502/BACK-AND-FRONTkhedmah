import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

const DAYS_OF_WEEK = [
  'SUNDAY',
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY',
] as const;

@Injectable()
export class ProviderScheduleService {
  constructor(private prisma: PrismaService) {}

  // ── Get provider's full weekly schedule ────────────────────────────────────
  async getSchedule(providerId: string) {
    const schedules = await this.prisma.providerSchedule.findMany({
      where: { providerId },
      orderBy: [{ dayOfWeek: 'asc' }],
    });

    // Return all 7 days, filling gaps with defaults (off)
    return DAYS_OF_WEEK.map((day) => {
      const found = schedules.find((s) => s.dayOfWeek === day);
      return (
        found ?? {
          providerId,
          dayOfWeek: day,
          startTime: '08:00',
          endTime: '18:00',
          isWorking: false,
        }
      );
    });
  }

  // ── Set a single day's schedule ────────────────────────────────────────────
  async setDaySchedule(
    userId: string,
    providerId: string,
    dayOfWeek: string,
    startTime: string,
    endTime: string,
    isWorking: boolean,
  ) {
    await this._assertOwner(userId, providerId);
    this._validateTime(startTime, endTime);

    return this.prisma.providerSchedule.upsert({
      where: { providerId_dayOfWeek: { providerId, dayOfWeek: dayOfWeek as any } },
      update: { startTime, endTime, isWorking },
      create: { providerId, dayOfWeek: dayOfWeek as any, startTime, endTime, isWorking },
    });
  }

  // ── Bulk update (save entire week at once) ─────────────────────────────────
  async bulkSetSchedule(
    userId: string,
    providerId: string,
    days: Array<{ dayOfWeek: string; startTime: string; endTime: string; isWorking: boolean }>,
  ) {
    await this._assertOwner(userId, providerId);

    for (const d of days) {
      if (d.isWorking) this._validateTime(d.startTime, d.endTime);
    }

    const ops = days.map((d) =>
      this.prisma.providerSchedule.upsert({
        where: { providerId_dayOfWeek: { providerId, dayOfWeek: d.dayOfWeek as any } },
        update: { startTime: d.startTime, endTime: d.endTime, isWorking: d.isWorking },
        create: {
          providerId,
          dayOfWeek: d.dayOfWeek as any,
          startTime: d.startTime,
          endTime: d.endTime,
          isWorking: d.isWorking,
        },
      }),
    );

    return this.prisma.$transaction(ops);
  }

  // ── Quick presets ──────────────────────────────────────────────────────────
  async applyPreset(
    userId: string,
    providerId: string,
    preset: 'FULL_TIME' | 'MORNING' | 'EVENING',
  ) {
    await this._assertOwner(userId, providerId);

    const presets: Record<string, { start: string; end: string }> = {
      FULL_TIME: { start: '08:00', end: '20:00' },
      MORNING: { start: '07:00', end: '13:00' },
      EVENING: { start: '14:00', end: '22:00' },
    };
    const { start, end } = presets[preset];

    // Apply to work days (Mon-Thu + Sat, not Fri/Sun for Saudi convention)
    const workDays = ['SATURDAY', 'SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY'];
    const ops = DAYS_OF_WEEK.map((day) =>
      this.prisma.providerSchedule.upsert({
        where: { providerId_dayOfWeek: { providerId, dayOfWeek: day } },
        update: { startTime: start, endTime: end, isWorking: workDays.includes(day) },
        create: {
          providerId,
          dayOfWeek: day,
          startTime: start,
          endTime: end,
          isWorking: workDays.includes(day),
        },
      }),
    );
    await this.prisma.$transaction(ops);
    return { message: `Preset ${preset} applied` };
  }

  // ── Vacation management ────────────────────────────────────────────────────
  async addVacation(
    userId: string,
    providerId: string,
    startDate: Date,
    endDate: Date,
    reason?: string,
  ) {
    await this._assertOwner(userId, providerId);
    if (startDate >= endDate) throw new BadRequestException('startDate must be before endDate');

    return this.prisma.providerVacation.create({
      data: { providerId, startDate, endDate, reason },
    });
  }

  async removeVacation(userId: string, vacationId: string) {
    const vacation = await this.prisma.providerVacation.findUnique({
      where: { id: vacationId },
      include: { provider: true },
    });
    if (!vacation) throw new NotFoundException('Vacation not found');
    if (vacation.provider.userId !== userId) throw new ForbiddenException('Not your vacation');
    return this.prisma.providerVacation.delete({ where: { id: vacationId } });
  }

  async getVacations(providerId: string) {
    return this.prisma.providerVacation.findMany({
      where: { providerId, endDate: { gte: new Date() } },
      orderBy: { startDate: 'asc' },
    });
  }

  // ── Availability check (for booking) ──────────────────────────────────────
  async isAvailableOn(providerId: string, date: Date): Promise<boolean> {
    const dayName = DAYS_OF_WEEK[date.getDay()];

    // Check vacation blocks
    const vacation = await this.prisma.providerVacation.findFirst({
      where: { providerId, startDate: { lte: date }, endDate: { gte: date } },
    });
    if (vacation) return false;

    // Check weekly schedule
    const schedule = await this.prisma.providerSchedule.findUnique({
      where: { providerId_dayOfWeek: { providerId, dayOfWeek: dayName } },
    });
    return schedule?.isWorking ?? false;
  }

  // ── Private helpers ────────────────────────────────────────────────────────
  private async _assertOwner(userId: string, providerId: string) {
    const profile = await this.prisma.providerProfile.findUnique({ where: { id: providerId } });
    if (!profile) throw new NotFoundException('Provider profile not found');
    if (profile.userId !== userId) throw new ForbiddenException('Not your profile');
    return profile;
  }

  private _validateTime(startTime: string, endTime: string) {
    const timeRe = /^([01]\d|2[0-3]):[0-5]\d$/;
    if (!timeRe.test(startTime) || !timeRe.test(endTime)) {
      throw new BadRequestException('Times must be in HH:MM format');
    }
    if (startTime >= endTime) {
      throw new BadRequestException('startTime must be before endTime');
    }
  }
}
