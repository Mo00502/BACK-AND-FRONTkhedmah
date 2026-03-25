import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Save a notification to the database for a user.
   */
  async notify(
    userId: string,
    title: string,
    body: string,
    type: string,
    metadata?: any,
  ) {
    const notification = await this.prisma.notification.create({
      data: {
        userId,
        title,
        body,
        type,
        metadata: metadata ?? null,
        isRead: false,
      },
    });

    this.logger.debug(`Notification sent: userId=${userId} type=${type} title="${title}"`);
    return notification;
  }

  /**
   * Get all notifications for a user, ordered newest first.
   */
  async getMyNotifications(userId: string, page = 1, limit = 30) {
    const skip = (page - 1) * limit;

    const [notifications, total, unreadCount] = await Promise.all([
      this.prisma.notification.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.notification.count({ where: { userId } }),
      this.prisma.notification.count({ where: { userId, isRead: false } }),
    ]);

    return { notifications, total, unreadCount, page, limit };
  }

  /**
   * Mark a single notification as read.
   */
  async markRead(notificationId: string, userId: string): Promise<void> {
    const notification = await this.prisma.notification.findUnique({
      where: { id: notificationId },
    });

    if (!notification) {
      throw new NotFoundException(`Notification ${notificationId} not found`);
    }

    if (notification.userId !== userId) {
      throw new ForbiddenException('This notification does not belong to you');
    }

    await this.prisma.notification.update({
      where: { id: notificationId },
      data: { isRead: true },
    });
  }

  /**
   * Mark all unread notifications for a user as read.
   */
  async markAllRead(userId: string): Promise<{ updated: number }> {
    const result = await this.prisma.notification.updateMany({
      where: { userId, isRead: false },
      data: { isRead: true },
    });

    this.logger.debug(`Marked ${result.count} notifications read for user=${userId}`);
    return { updated: result.count };
  }
}
