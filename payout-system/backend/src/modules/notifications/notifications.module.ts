import { Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { NotificationEventListener } from './event-listener.service';
import { NotificationsController } from './notifications.controller';

@Module({
  providers: [NotificationsService, NotificationEventListener],
  controllers: [NotificationsController],
  exports: [NotificationsService],
})
export class NotificationsModule {}
