import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import * as helmet from 'helmet';
import * as compression from 'compression';
import * as Sentry from '@sentry/node';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log', 'debug'],
  });

  const configService = app.get(ConfigService);
  const nodeEnv = configService.get<string>('NODE_ENV', 'development');
  const sentryDsn = configService.get<string>('SENTRY_DSN');

  // Sentry initialization
  if (sentryDsn) {
    Sentry.init({
      dsn: sentryDsn,
      environment: nodeEnv,
      tracesSampleRate: nodeEnv === 'production' ? 0.1 : 1.0,
    });
  }

  // Security middleware
  app.use(helmet());
  app.use(compression());

  // CORS
  app.enableCors({
    origin: configService.get<string>('APP_URL', 'http://localhost:3000'),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Idempotency-Key'],
  });

  // Global prefix
  app.setGlobalPrefix('api/v1');

  // Global pipes
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // Global filters
  app.useGlobalFilters(new HttpExceptionFilter());

  // Global interceptors
  app.useGlobalInterceptors(new ResponseInterceptor());

  // Swagger
  if (nodeEnv !== 'production') {
    const config = new DocumentBuilder()
      .setTitle('Payout System API')
      .setDescription('Saudi Arabia Payment & Payout System — Production-Ready API')
      .setVersion('1.0')
      .addBearerAuth()
      .addTag('auth', 'Authentication endpoints')
      .addTag('orders', 'Order management')
      .addTag('payments', 'Payment processing via Moyasar')
      .addTag('payouts', 'Provider payout management')
      .addTag('wallet', 'Wallet operations')
      .addTag('notifications', 'User notifications')
      .build();

    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('docs', app, document, {
      swaggerOptions: { persistAuthorization: true },
    });
  }

  const port = configService.get<number>('PORT', 3000);
  await app.listen(port);
  console.log(`Application running on: http://localhost:${port}/api/v1`);
  console.log(`Swagger docs: http://localhost:${port}/docs`);
}

bootstrap();
