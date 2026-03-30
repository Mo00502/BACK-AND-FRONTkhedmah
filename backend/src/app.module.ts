import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import Redis from 'ioredis';
import { CacheModule } from '@nestjs/cache-manager';
import { BullModule } from '@nestjs/bull';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { redisStore } from 'cache-manager-redis-yet';
import { WinstonModule } from 'nest-winston';

import { envValidationSchema } from './common/config/env.validation';
import { buildWinstonConfig } from './common/config/logger.config';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { ProvidersModule } from './modules/providers/providers.module';
import { ServicesModule } from './modules/services/services.module';
import { RequestsModule } from './modules/requests/requests.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { FilesModule } from './modules/files/files.module';
import { ReviewsModule } from './modules/reviews/reviews.module';
import { AdminModule } from './modules/admin/admin.module';
import { AuditModule } from './modules/audit/audit.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { HealthModule } from './modules/health/health.module';
// Level 31–34
import { WalletModule } from './modules/wallet/wallet.module';
import { CompaniesModule } from './modules/companies/companies.module';
import { TendersModule } from './modules/tenders/tenders.module';
import { EquipmentModule } from './modules/equipment/equipment.module';
// Level 54–55
import { InvoicesModule } from './modules/invoices/invoices.module';
import { SearchModule } from './modules/search/search.module';
// Split-payment
import { MaterialsPaymentModule } from './modules/materials-payment/materials-payment.module';
// Level 66–70
import { ProviderScheduleModule } from './modules/schedule/provider-schedule.module';
import { FavouritesModule } from './modules/favourites/favourites.module';
import { DisputesModule } from './modules/disputes/disputes.module';
// Level 71–79
import { TrackingModule } from './modules/tracking/tracking.module';
import { PromotionsModule } from './modules/promotions/promotions.module';
import { PortfolioModule } from './modules/portfolio/portfolio.module';
import { ReportsModule } from './modules/reports/reports.module';
import { LeaderboardModule } from './modules/leaderboard/leaderboard.module';
// Level 41–50
import { ChatModule } from './modules/chat/chat.module';
import { SchedulerModule } from './modules/scheduler/scheduler.module';
import { EventsModule } from './modules/events/events.module';
import { RewardsModule } from './modules/rewards/rewards.module';
import { EquipmentReviewsModule } from './modules/equipment-reviews/equipment-reviews.module';
import { SupportModule } from './modules/support/support.module';
import { ConsultationsModule } from './modules/consultations/consultations.module';
import { AiModule } from './modules/ai/ai.module';
import { MapsModule } from './modules/maps/maps.module';
import { AddressesModule } from './modules/addresses/addresses.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validationSchema: envValidationSchema }),

    // ── Structured logging (Winston) ──────────────────────────────────────
    // Replaces NestJS default logger — used via `app.useLogger()` in main.ts
    WinstonModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        buildWinstonConfig(config.get('NODE_ENV', 'development')),
    }),

    // Rate limiting backed by Redis so limits are shared across all instances.
    // In-process memory store is NOT used — counters survive restarts and
    // work correctly behind a load balancer or with horizontal scaling.
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService): any => {
        const redisClient = new Redis({
          host: config.get('REDIS_HOST', 'localhost'),
          port: config.get<number>('REDIS_PORT', 6379),
          password: config.get('REDIS_PASSWORD') || undefined,
          // Namespace throttler keys to avoid collisions with Bull / Cache keys
          keyPrefix: 'khedmah:throttle:',
          // Reconnect automatically — rate limit store should be resilient
          retryStrategy: (times) => Math.min(times * 50, 2000),
          lazyConnect: true,
        });

        return {
          storage: new ThrottlerStorageRedisService(redisClient),
          throttlers: [
            {
              // This is the global default — individual endpoints override via
              // @ThrottleAuth() / @ThrottleStrict() / @ThrottleDefault() / @ThrottleRelaxed()
              name: 'default',
              ttl: config.get<number>('THROTTLE_TTL', 60_000),
              limit: config.get<number>('THROTTLE_LIMIT', 60),
            },
          ],
          // Generate throttle key from IP + route + user-id (if authenticated)
          // so authenticated users have their own counter separate from anonymous
          generateKey: (context: any, suffix: string, throttlerName: string) => {
            const req = context.switchToHttp().getRequest();
            const userId = req.user?.id ?? 'anon';
            const ip = (req.headers['x-forwarded-for'] ?? req.ip ?? 'unknown')
              .toString()
              .split(',')[0]
              .trim();
            return `${throttlerName}:${ip}:${userId}:${suffix}`;
          },
        };
      },
    }),

    CacheModule.registerAsync({
      isGlobal: true,
      inject: [ConfigService],
      useFactory: async (config: ConfigService) => ({
        store: await redisStore({
          socket: {
            host: config.get('REDIS_HOST', 'localhost'),
            port: config.get<number>('REDIS_PORT', 6379),
          },
          password: config.get('REDIS_PASSWORD') || undefined,
        }),
        ttl: 300_000,
      }),
    }),

    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        redis: {
          host: config.get('REDIS_HOST', 'localhost'),
          port: config.get<number>('REDIS_PORT', 6379),
          password: config.get('REDIS_PASSWORD') || undefined,
        },
      }),
    }),

    EventEmitterModule.forRoot({ wildcard: true }),
    ScheduleModule.forRoot(),

    // ── Core ──────────────────────────────────────────────
    PrismaModule,
    AuthModule,
    UsersModule,
    ProvidersModule,
    ServicesModule,
    RequestsModule,

    // ── Payments & Escrow ─────────────────────────────────
    PaymentsModule,
    WalletModule,

    // ── Communication ─────────────────────────────────────
    NotificationsModule,
    ChatModule,

    // ── Files & Media ─────────────────────────────────────
    FilesModule,

    // ── Reviews & Rewards ─────────────────────────────────
    ReviewsModule,
    EquipmentReviewsModule,
    RewardsModule,

    // ── B2B Tender Ecosystem ──────────────────────────────
    CompaniesModule,
    TendersModule,

    // ── Equipment Marketplace ─────────────────────────────
    EquipmentModule,

    // ── Invoices & Search ─────────────────────────────────
    InvoicesModule,
    SearchModule,
    MaterialsPaymentModule,

    // ── Schedule, Favourites & Disputes ───────────────────
    ProviderScheduleModule,
    FavouritesModule,
    DisputesModule,

    // ── Tracking, Promotions, Portfolio ───────────────────
    TrackingModule,
    PromotionsModule,
    PortfolioModule,

    // ── Reports & Leaderboard ─────────────────────────────
    ReportsModule,
    LeaderboardModule,

    // ── Support ───────────────────────────────────────────
    SupportModule,

    // ── Consultations ─────────────────────────────────────
    ConsultationsModule,

    // ── AI Assistant ──────────────────────────────────────
    AiModule,

    // ── Maps (geocoding, distance, autocomplete) ──────────
    MapsModule,

    // ── Customer Saved Addresses ──────────────────────────
    AddressesModule,

    // ── Admin & Analytics ─────────────────────────────────
    AdminModule,
    AuditModule,
    AnalyticsModule,
    HealthModule,

    // ── Infrastructure ────────────────────────────────────
    SchedulerModule,
    EventsModule,
  ],
})
export class AppModule {}
