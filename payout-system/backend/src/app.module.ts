import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import * as Joi from 'joi';

import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './modules/auth/auth.module';
import { OrdersModule } from './modules/orders/orders.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { CommissionModule } from './modules/commission/commission.module';
import { EscrowModule } from './modules/escrow/escrow.module';
import { ReleaseModule } from './modules/release/release.module';
import { PayoutModule } from './modules/payout/payout.module';
import { WalletModule } from './modules/wallet/wallet.module';
import { LedgerModule } from './modules/ledger/ledger.module';
import { NotificationsModule } from './modules/notifications/notifications.module';

@Module({
  imports: [
    // Config with env validation
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: Joi.object({
        DATABASE_URL: Joi.string().required(),
        REDIS_URL: Joi.string().required(),
        JWT_SECRET: Joi.string().min(32).required(),
        JWT_REFRESH_SECRET: Joi.string().min(32).required(),
        JWT_EXPIRES_IN: Joi.string().default('15m'),
        JWT_REFRESH_EXPIRES_IN: Joi.string().default('30d'),
        MOYASAR_SECRET_KEY: Joi.string().required(),
        MOYASAR_PUBLISHABLE_KEY: Joi.string().required(),
        MOYASAR_WEBHOOK_SECRET: Joi.string().required(),
        PLATFORM_COMMISSION_RATE: Joi.number().default(0.15),
        VAT_RATE: Joi.number().default(0.15),
        ESCROW_AUTO_RELEASE_HOURS: Joi.number().default(48),
        PAYOUT_ENCRYPTION_KEY: Joi.string().min(32).required(),
        APP_URL: Joi.string().default('http://localhost:3000'),
        NODE_ENV: Joi.string().valid('development', 'production', 'test').default('development'),
        PORT: Joi.number().default(3000),
        SENTRY_DSN: Joi.string().optional().allow(''),
      }),
    }),

    // BullMQ with Redis
    BullModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        connection: {
          url: configService.get<string>('REDIS_URL'),
        },
        defaultJobOptions: {
          attempts: 5,
          backoff: {
            type: 'exponential',
            delay: 2000,
          },
          removeOnComplete: 100,
          removeOnFail: 500,
        },
      }),
      inject: [ConfigService],
    }),

    // Event emitter
    EventEmitterModule.forRoot({
      wildcard: false,
      delimiter: '.',
      maxListeners: 20,
      verboseMemoryLeak: true,
    }),

    // Cron scheduler
    ScheduleModule.forRoot(),

    // Core
    PrismaModule,

    // Feature modules
    AuthModule,
    OrdersModule,
    PaymentsModule,
    CommissionModule,
    EscrowModule,
    ReleaseModule,
    PayoutModule,
    WalletModule,
    LedgerModule,
    NotificationsModule,
  ],
})
export class AppModule {}
