import { Module } from '@nestjs/common';
import { EventListenerService } from './event-listener.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { WalletModule } from '../wallet/wallet.module';
import { PaymentsModule } from '../payments/payments.module';

@Module({
  imports: [PrismaModule, NotificationsModule, WalletModule, PaymentsModule],
  providers: [EventListenerService],
})
export class EventsModule {}
