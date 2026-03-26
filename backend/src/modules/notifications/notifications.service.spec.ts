import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getQueueToken } from '@nestjs/bull';
import { NotificationsService } from './notifications.service';
import { PrismaService } from '../../prisma/prisma.service';
import * as nodemailer from 'nodemailer';

jest.mock('nodemailer');

const mockPrisma = {
  notification: {
    create: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
  deviceToken: {
    updateMany: jest.fn(),
    upsert: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
  },
};

const mockNotifQueue = {
  add: jest.fn().mockResolvedValue(undefined),
};

const mockConfig = {
  get: jest.fn(),
  getOrThrow: jest.fn(),
};

const mockTransporter = {
  sendMail: jest.fn().mockResolvedValue({ messageId: 'test-id' }),
};

describe('NotificationsService', () => {
  let service: NotificationsService;

  beforeEach(async () => {
    jest.clearAllMocks();

    (nodemailer.createTransport as jest.Mock).mockReturnValue(mockTransporter);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: ConfigService, useValue: mockConfig },
        { provide: getQueueToken('notifications'), useValue: mockNotifQueue },
      ],
    }).compile();

    service = module.get<NotificationsService>(NotificationsService);
  });

  // ── createInApp ────────────────────────────────────────────────────────────
  describe('createInApp', () => {
    it('creates a notification record in the DB', async () => {
      const created = { id: 'notif-1', userId: 'user-1', titleAr: 'عنوان', bodyAr: 'نص', channel: 'IN_APP' };
      mockPrisma.notification.create.mockResolvedValue(created);

      const result = await service.createInApp('user-1', 'عنوان', 'نص', { key: 'val' });

      expect(mockPrisma.notification.create).toHaveBeenCalledWith({
        data: { userId: 'user-1', channel: 'IN_APP', titleAr: 'عنوان', bodyAr: 'نص', data: { key: 'val' } },
      });
      expect(result).toBe(created);
    });

    it('creates notification without extra data', async () => {
      mockPrisma.notification.create.mockResolvedValue({ id: 'notif-2' });

      await service.createInApp('user-2', 'تفعيل', 'تم التفعيل');

      expect(mockPrisma.notification.create).toHaveBeenCalledWith({
        data: { userId: 'user-2', channel: 'IN_APP', titleAr: 'تفعيل', bodyAr: 'تم التفعيل', data: undefined },
      });
    });
  });

  // ── notifyUser ─────────────────────────────────────────────────────────────
  describe('notifyUser', () => {
    it('calls createInApp and adds a push job to the queue', async () => {
      mockPrisma.notification.create.mockResolvedValue({ id: 'notif-1' });

      await service.notifyUser('user-1', 'عنوان', 'نص', { requestId: 'req-1' });

      expect(mockPrisma.notification.create).toHaveBeenCalledTimes(1);
      expect(mockNotifQueue.add).toHaveBeenCalledWith(
        'push',
        { userId: 'user-1', title: 'عنوان', body: 'نص', data: { requestId: 'req-1' } },
        expect.objectContaining({ attempts: 3 }),
      );
    });

    it('passes empty object for data when extra is undefined', async () => {
      mockPrisma.notification.create.mockResolvedValue({ id: 'notif-2' });

      await service.notifyUser('user-1', 'تنبيه', 'محتوى');

      expect(mockNotifQueue.add).toHaveBeenCalledWith(
        'push',
        expect.objectContaining({ data: {} }),
        expect.any(Object),
      );
    });
  });

  // ── getMyNotifications ────────────────────────────────────────────────────
  describe('getMyNotifications', () => {
    it('returns paginated notifications with unread count', async () => {
      const notifs = [{ id: 'n1' }, { id: 'n2' }];
      mockPrisma.notification.findMany.mockResolvedValue(notifs);
      mockPrisma.notification.count
        .mockResolvedValueOnce(10)  // total
        .mockResolvedValueOnce(3);  // unread

      const result = await service.getMyNotifications('user-1', 1, 20);

      expect(result).toEqual({ notifications: notifs, total: 10, unread: 3 });
      expect(mockPrisma.notification.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: 'user-1' }, skip: 0, take: 20 }),
      );
    });

    it('calculates correct skip for page 2', async () => {
      mockPrisma.notification.findMany.mockResolvedValue([]);
      mockPrisma.notification.count.mockResolvedValue(0);

      await service.getMyNotifications('user-1', 2, 10);

      expect(mockPrisma.notification.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 10, take: 10 }),
      );
    });
  });

  // ── markRead ──────────────────────────────────────────────────────────────
  describe('markRead', () => {
    it('marks a single notification as read', async () => {
      mockPrisma.notification.findUnique.mockResolvedValue({ id: 'n1', userId: 'user-1' });
      mockPrisma.notification.update.mockResolvedValue({ id: 'n1', read: true });

      const result = await service.markRead('user-1', 'n1');

      expect(mockPrisma.notification.update).toHaveBeenCalledWith({
        where: { id: 'n1' },
        data: { read: true },
      });
      expect(result).toEqual({ message: 'Marked as read' });
    });

    it('throws NotFoundException when notification does not exist', async () => {
      mockPrisma.notification.findUnique.mockResolvedValue(null);

      await expect(service.markRead('user-1', 'missing-id')).rejects.toThrow(NotFoundException);
    });

    it('throws ForbiddenException when notification belongs to another user', async () => {
      mockPrisma.notification.findUnique.mockResolvedValue({ id: 'n1', userId: 'other-user' });

      await expect(service.markRead('user-1', 'n1')).rejects.toThrow(ForbiddenException);
    });

    it('marks all unread notifications when no notificationId given', async () => {
      mockPrisma.notification.updateMany.mockResolvedValue({ count: 5 });

      const result = await service.markRead('user-1');

      expect(mockPrisma.notification.updateMany).toHaveBeenCalledWith({
        where: { userId: 'user-1', read: false },
        data: { read: true },
      });
      expect(result).toEqual({ message: 'Marked as read' });
    });
  });

  // ── sendEmail ─────────────────────────────────────────────────────────────
  describe('sendEmail', () => {
    it('creates transporter and sends email when SMTP_HOST is configured', async () => {
      mockConfig.get.mockImplementation((key: string, def?: any) => {
        if (key === 'SMTP_HOST') return 'smtp.example.com';
        if (key === 'SMTP_PORT') return 587;
        if (key === 'SMTP_SECURE') return false;
        if (key === 'SMTP_USER') return 'user@example.com';
        if (key === 'SMTP_PASS') return 'secret';
        if (key === 'SMTP_FROM') return 'noreply@khedmah.sa';
        return def;
      });

      await service.sendEmail('to@example.com', 'Test Subject', '<p>Hello</p>');

      expect(nodemailer.createTransport).toHaveBeenCalledTimes(1);
      expect(mockTransporter.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'to@example.com', subject: 'Test Subject' }),
      );
    });

    it('skips email silently when SMTP_HOST is not set', async () => {
      mockConfig.get.mockReturnValue(undefined);

      await expect(service.sendEmail('to@example.com', 'Subject', '<p/>')).resolves.not.toThrow();
      expect(mockTransporter.sendMail).not.toHaveBeenCalled();
    });

    it('does not throw when sendMail rejects (logs error instead)', async () => {
      mockConfig.get.mockImplementation((key: string, def?: any) => {
        if (key === 'SMTP_HOST') return 'smtp.example.com';
        return def;
      });
      mockTransporter.sendMail.mockRejectedValue(new Error('SMTP failure'));

      await expect(
        service.sendEmail('to@example.com', 'Subject', '<p/>'),
      ).resolves.not.toThrow();
    });
  });

  // ── registerDeviceToken ───────────────────────────────────────────────────
  describe('registerDeviceToken', () => {
    it('deactivates token for other users and upserts for current user', async () => {
      const upserted = { token: 'fcm-token', userId: 'user-1', platform: 'ANDROID', active: true };
      mockPrisma.deviceToken.updateMany.mockResolvedValue({ count: 0 });
      mockPrisma.deviceToken.upsert.mockResolvedValue(upserted);

      const result = await service.registerDeviceToken('user-1', 'fcm-token', 'ANDROID');

      expect(mockPrisma.deviceToken.updateMany).toHaveBeenCalledWith({
        where: { token: 'fcm-token', userId: { not: 'user-1' } },
        data: { active: false },
      });
      expect(mockPrisma.deviceToken.upsert).toHaveBeenCalledWith({
        where: { token: 'fcm-token' },
        update: { userId: 'user-1', active: true, platform: 'ANDROID' },
        create: { userId: 'user-1', token: 'fcm-token', platform: 'ANDROID', active: true },
      });
      expect(result).toBe(upserted);
    });
  });

  // ── unregisterDeviceToken ─────────────────────────────────────────────────
  describe('unregisterDeviceToken', () => {
    it('deactivates device token for owner', async () => {
      mockPrisma.deviceToken.findUnique.mockResolvedValue({ token: 'fcm-token', userId: 'user-1' });
      mockPrisma.deviceToken.update.mockResolvedValue({ token: 'fcm-token', active: false });

      await service.unregisterDeviceToken('user-1', 'fcm-token');

      expect(mockPrisma.deviceToken.update).toHaveBeenCalledWith({
        where: { token: 'fcm-token' },
        data: { active: false },
      });
    });

    it('returns silently when token does not exist', async () => {
      mockPrisma.deviceToken.findUnique.mockResolvedValue(null);

      await expect(service.unregisterDeviceToken('user-1', 'missing-token')).resolves.not.toThrow();
      expect(mockPrisma.deviceToken.update).not.toHaveBeenCalled();
    });

    it('returns silently when token belongs to a different user', async () => {
      mockPrisma.deviceToken.findUnique.mockResolvedValue({ token: 'fcm-token', userId: 'other-user' });

      await expect(service.unregisterDeviceToken('user-1', 'fcm-token')).resolves.not.toThrow();
      expect(mockPrisma.deviceToken.update).not.toHaveBeenCalled();
    });
  });
});
