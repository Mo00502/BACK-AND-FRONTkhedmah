import { Module } from '@nestjs/common';
import { EventListenerService } from './event-listener.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { WalletModule } from '../wallet/wallet.module';

@Module({
  imports: [PrismaModule, NotificationsModule, WalletModule],
  providers: [EventListenerService],
})
export class EventsModule {}
