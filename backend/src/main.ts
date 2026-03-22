import { NestFactory, Reflector } from '@nestjs/core';
import { ValidationPipe, ClassSerializerInterceptor, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { ThrottlerGuard } from '@nestjs/throttler';
import helmet from 'helmet';
import compression from 'compression';
import { json, urlencoded } from 'express';
import * as Sentry from '@sentry/node';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { RolesGuard } from './common/guards/roles.guard';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const config = app.get(ConfigService);
  const isProd = config.get('NODE_ENV') === 'production';

  // ── Winston structured logging ────────────────────────────────────────────
  // Replaces NestJS default logger with Winston (JSON in prod, pretty in dev)
  app.useLogger(app.get(WINSTON_MODULE_NEST_PROVIDER));

  // ── Sentry error tracking ─────────────────────────────────────────────────
  // Only initialise when SENTRY_DSN is configured (skipped in local dev)
  const sentryDsn = config.get<string>('SENTRY_DSN');
  if (sentryDsn) {
    Sentry.init({
      dsn: sentryDsn,
      environment: config.get('NODE_ENV', 'development'),
      release: config.get('APP_VERSION', 'unknown'),
      // Capture 100% of transactions in dev; tune down in production
      tracesSampleRate: isProd ? 0.1 : 1.0,
      // Capture 10% of sessions for profiling in production
      profilesSampleRate: isProd ? 0.1 : 1.0,
    });
  }

  // ── Request body size limits (prevent large-payload DoS) ────────────────
  // File uploads use multipart — handled by FilesModule directly
  app.use(json({ limit: '1mb' }));
  app.use(urlencoded({ extended: true, limit: '1mb' }));

  // ── Helmet: security headers ─────────────────────────────────────────────
  app.use(
    helmet({
      // Content-Security-Policy: tight policy for an API (no HTML served)
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'none'"],
          scriptSrc: ["'none'"],
          styleSrc: ["'none'"],
          imgSrc: ["'none'"],
          connectSrc: ["'self'"],
          frameSrc: ["'none'"],
          objectSrc: ["'none'"],
          upgradeInsecureRequests: isProd ? [] : null,
        },
      },
      // Strict Transport Security: enforce HTTPS for 1 year in production
      strictTransportSecurity: isProd
        ? { maxAge: 31_536_000, includeSubDomains: true, preload: true }
        : false,
      // Disable X-Powered-By to avoid fingerprinting
      hidePoweredBy: true,
      // Prevent MIME-type sniffing
      noSniff: true,
      // Prevent clickjacking
      frameguard: { action: 'deny' },
      // XSS filter (legacy browsers)
      xssFilter: true,
      // Referrer policy — don't leak URL to third parties
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    }),
  );

  // ── Compression (gzip for responses > 1KB) ───────────────────────────────
  app.use(compression({ threshold: 1024 }));

  // ── CORS ─────────────────────────────────────────────────────────────────
  const allowedOrigins = config
    .get<string>('ALLOWED_ORIGINS', 'http://localhost:5173')
    .split(',')
    .map((o) => o.trim());

  app.enableCors({
    origin: (origin, callback) => {
      // Allow requests with no origin (mobile apps, curl, server-to-server)
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin) || !isProd) {
        return callback(null, true);
      }
      callback(new Error(`CORS: origin '${origin}' not allowed`));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Request-ID',
      'X-Forwarded-For',
      'Accept-Language',
    ],
    exposedHeaders: ['X-Request-ID', 'X-Response-Time'],
    maxAge: 600, // preflight cache: 10 minutes
  });

  // ── Global prefix + URI versioning ───────────────────────────────────────
  app.setGlobalPrefix('api', {
    exclude: ['/health', '/health/live', '/health/ready'],
  });

  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: '1',
  });

  // ── Global pipes ─────────────────────────────────────────────────────────
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
      // Prevent prototype pollution via class-transformer
      enableDebugMessages: !isProd,
    }),
  );

  // ── Global filters, guards & interceptors ────────────────────────────────
  const reflector = app.get(Reflector);
  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalGuards(app.get(ThrottlerGuard), new RolesGuard(reflector));
  app.useGlobalInterceptors(
    new LoggingInterceptor(),
    new ResponseInterceptor(),
    new ClassSerializerInterceptor(reflector),
  );

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  // dumb-init in Docker sends SIGTERM; this ensures in-flight requests finish
  app.enableShutdownHooks();

  // ── Swagger (non-production only) ─────────────────────────────────────────
  if (!isProd) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Khedmah API')
      .setDescription(
        'Saudi Home Services Marketplace — REST API\n\n' +
          '**Split-Payment Model:** Every order supports two independent financial records:\n' +
          '- 🔒 **Service Escrow** — held until customer confirms completion\n' +
          '- ⚡ **Materials Budget** — available immediately for provider to purchase supplies\n\n' +
          'Authentication: `Bearer <access_token>` (JWT, 15-min expiry)',
      )
      .setVersion('1.0')
      .addBearerAuth()
      .addTag('auth', 'Authentication — email/password, JWT, email verification')
      .addTag('users', 'User management')
      .addTag('providers', 'Provider profiles & earnings')
      .addTag('services', 'Service catalog')
      .addTag('requests', 'Service requests & quotes')
      .addTag('payments', 'Payments, escrow & split-payment')
      .addTag('materials-payment', 'Materials budget — usage logs, receipts, reconciliation')
      .addTag('reviews', 'Ratings & reviews')
      .addTag('notifications', 'Push & in-app notifications')
      .addTag('files', 'File uploads (S3)')
      .addTag('admin', 'Admin operations')
      .addTag('analytics', 'Platform analytics & GMV')
      .addTag('wallet', 'User wallets & transactions')
      .addTag('companies', 'Company profiles (B2B)')
      .addTag('tenders', 'Tender management & bidding')
      .addTag('equipment', 'Equipment marketplace')
      .addTag('chat', 'Messaging & conversations')
      .addTag('rewards', 'Referral & loyalty rewards')
      .addTag('equipment-reviews', 'Equipment ratings')
      .addTag('search', 'Unified search & autocomplete')
      .addTag('invoices', 'Invoice generation (VAT 15%)')
      .addTag('disputes', 'Dispute filing & resolution')
      .addTag('promotions', 'Promo codes & discount engine')
      .addTag('support', 'Customer support tickets')
      .addTag('health', 'Health probes (liveness / readiness)')
      .build();

    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('api/docs', app, document, {
      swaggerOptions: {
        persistAuthorization: true,
        tagsSorter: 'alpha',
        operationsSorter: 'alpha',
      },
    });
  }

  const port = config.get<number>('PORT', 3000);
  await app.listen(port);

  if (!isProd) {
    console.log(`\nKhedmah API  → http://localhost:${port}/api/v1`);
    console.log(`Swagger docs → http://localhost:${port}/api/docs\n`);
  }
}

bootstrap();
