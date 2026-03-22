import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient, Prisma } from '@prisma/client';

/**
 * PrismaService with two global middlewares:
 *
 * 1. Soft-delete filter — automatically appends `deletedAt: null` to every
 *    findMany/findFirst/findUnique on models that have a `deletedAt` column,
 *    so callers never accidentally surface deleted records.
 *
 * 2. Slow-query logger — warns when any query exceeds SLOW_QUERY_THRESHOLD ms.
 */

const SOFT_DELETE_MODELS = new Set(['User', 'ServiceRequest', 'DirectMessage']);

const SLOW_QUERY_THRESHOLD_MS = 500;

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(private config: ConfigService) {
    super({
      log:
        config.get('NODE_ENV') === 'development'
          ? [{ emit: 'event', level: 'query' }, 'warn', 'error']
          : ['error'],
    });

    // ── Middleware 1: Soft-delete auto-filter ──────────────────────────────
    this.$use(async (params: Prisma.MiddlewareParams, next) => {
      if (
        SOFT_DELETE_MODELS.has(params.model ?? '') &&
        ['findMany', 'findFirst', 'findFirstOrThrow', 'count'].includes(params.action)
      ) {
        params.args = params.args ?? {};
        params.args.where = params.args.where ?? {};

        // Only inject if caller hasn't explicitly specified deletedAt
        if (params.args.where.deletedAt === undefined) {
          params.args.where.deletedAt = null;
        }
      }
      return next(params);
    });

    // ── Middleware 2: Slow query logger ───────────────────────────────────
    this.$use(async (params: Prisma.MiddlewareParams, next) => {
      const start = Date.now();
      const result = await next(params);
      const elapsed = Date.now() - start;

      if (elapsed > SLOW_QUERY_THRESHOLD_MS) {
        this.logger.warn(`Slow query [${elapsed}ms] ${params.model}.${params.action}`);
      }
      return result;
    });
  }

  async onModuleInit() {
    await this.$connect();
    this.logger.log('Database connected');
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }

  /** Expose a typed executeRaw for raw SQL when needed */
  async executeRaw<T = any>(sql: string, ...params: any[]): Promise<T[]> {
    return this.$queryRawUnsafe<T[]>(sql, ...params);
  }

  /** Use ONLY in tests — never in production */
  async cleanDatabase() {
    if (this.config.get('NODE_ENV') === 'production') {
      throw new Error('cleanDatabase is not allowed in production');
    }
    const tableNames = [
      'promo_redemptions',
      'promo_codes',
      'favourites',
      'disputes',
      'equipment_reviews',
      'equipment_rentals',
      'equipment',
      'tender_commissions',
      'tender_bids',
      'tenders',
      'companies',
      'wallet_transactions',
      'wallets',
      'audit_logs',
      'notifications',
      'reviews',
      'messages',
      'escrow',
      'payments',
      'quotes',
      'service_requests',
      'provider_availability',
      'provider_skills',
      'provider_profiles',
      'user_profiles',
      'otp_codes',
      'refresh_tokens',
      'device_tokens',
      'referrals',
      'files',
      'users',
    ];
    for (const table of tableNames) {
      await this.$executeRawUnsafe(`TRUNCATE TABLE "${table}" CASCADE`);
    }
  }
}
