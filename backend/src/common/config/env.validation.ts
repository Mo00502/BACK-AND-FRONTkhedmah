import * as Joi from 'joi';

/**
 * Joi schema for environment variable validation.
 * Applied in AppModule via ConfigModule.forRoot({ validationSchema }).
 * Required vars throw on startup; optional vars have defaults.
 */
export const envValidationSchema = Joi.object({
  // ── App ─────────────────────────────────────────────────────────────────
  NODE_ENV: Joi.string().valid('development', 'production', 'test').default('development'),
  PORT: Joi.number().default(3000),
  // Comma-separated allowed CORS origins
  ALLOWED_ORIGINS: Joi.string().default('http://localhost:5173'),

  // ── Database ─────────────────────────────────────────────────────────────
  DATABASE_URL: Joi.string().required(),

  // ── Redis ────────────────────────────────────────────────────────────────
  REDIS_HOST: Joi.string().default('localhost'),
  REDIS_PORT: Joi.number().default(6379),
  REDIS_PASSWORD: Joi.string().optional().allow(''),

  // ── JWT ──────────────────────────────────────────────────────────────────
  JWT_SECRET: Joi.string().min(32).required(),
  JWT_EXPIRES_IN: Joi.string().default('15m'),
  JWT_REFRESH_SECRET: Joi.string().min(32).required(),
  JWT_REFRESH_EXPIRES_IN: Joi.string().default('30d'),

  // ── Email Auth Token Settings ────────────────────────────────────────────
  // How long email verification links stay valid (hours)
  EMAIL_VERIFY_TTL_HOURS: Joi.number().default(24),
  // How long password reset links stay valid (minutes)
  RESET_TOKEN_TTL_MINUTES: Joi.number().default(60),
  // Base URL used to build the verification/reset links in emails
  APP_BASE_URL: Joi.string().uri().default('http://localhost:3000'),

  // ── Rate Limiting (Redis-backed) ─────────────────────────────────────────
  THROTTLE_TTL: Joi.number().default(60_000),
  THROTTLE_LIMIT: Joi.number().default(60),

  // ── Scheduler ────────────────────────────────────────────────────────────
  ESCROW_AUTO_RELEASE_HOURS: Joi.number().default(48),
  MATERIALS_ADJUSTMENT_EXPIRY_HOURS: Joi.number().default(24),

  // ── Moyasar (payment gateway) ────────────────────────────────────────────
  // Required in production — app will start without them in dev/test but any
  // payment attempt will throw at runtime (getOrThrow) rather than silently fail.
  MOYASAR_API_KEY: Joi.string().when('NODE_ENV', {
    is: 'production',
    then: Joi.required(),
    otherwise: Joi.optional(),
  }),
  MOYASAR_WEBHOOK_SECRET: Joi.string().when('NODE_ENV', {
    is: 'production',
    then: Joi.required(),
    otherwise: Joi.optional(),
  }),
  MOYASAR_PUBLISHABLE_KEY: Joi.string().optional(),

  // ── Firebase (push notifications) ────────────────────────────────────────
  FIREBASE_SERVICE_ACCOUNT: Joi.string().optional(),

  // ── SMS (Unifonic) — kept optional; used only for provider contact notifications ──
  UNIFONIC_APP_SID: Joi.string().optional(),
  UNIFONIC_SENDER_ID: Joi.string().default('Khedmah'),

  // ── Storage (S3-compatible) ───────────────────────────────────────────────
  S3_ENDPOINT: Joi.string().uri().optional(),
  S3_REGION: Joi.string().default('me-central-1'),
  S3_BUCKET: Joi.string().default('khedmah-uploads'),
  S3_ACCESS_KEY: Joi.string().optional(),
  S3_SECRET_KEY: Joi.string().optional(),
  S3_MAX_FILE_SIZE_MB: Joi.number().default(20),
  S3_SIGNED_URL_EXPIRY: Joi.number().default(3600),

  // ── Email ─────────────────────────────────────────────────────────────────
  SMTP_HOST: Joi.string().optional(),
  SMTP_PORT: Joi.number().default(587),
  SMTP_SECURE: Joi.boolean().default(false),
  SMTP_USER: Joi.string().optional(),
  SMTP_PASS: Joi.string().optional(),
  SMTP_FROM: Joi.string().default('noreply@khedmah.sa'),
  ADMIN_EMAIL: Joi.string().email().optional(),
  REPORT_RECIPIENTS: Joi.string().optional(),

  // ── Platform Business Rules ───────────────────────────────────────────────
  PLATFORM_FEE_PERCENT: Joi.number().min(0).max(100).default(15),
  TENDER_COMMISSION_RATE: Joi.number().min(0).max(1).default(0.02),
  EQUIPMENT_FEE_RATE: Joi.number().min(0).max(1).default(0.1),

  // ── AI (Anthropic) ────────────────────────────────────────────────────────
  // Optional — AI endpoints return rule-based fallbacks when not set
  ANTHROPIC_API_KEY: Joi.string().optional().allow(''),

  // ── Maps (Google Maps Platform) ──────────────────────────────────────────
  // Optional — geocoding, distance calculation, and address autocomplete
  // degrade gracefully (return null) when not configured.
  GOOGLE_MAPS_API_KEY: Joi.string().optional().allow(''),

  // ── App versioning (used by Sentry release) ───────────────────────────────
  APP_VERSION: Joi.string().optional().default('0.0.0'),

  // ── Monitoring ────────────────────────────────────────────────────────────
  SENTRY_DSN: Joi.string().uri().optional().allow(''),
  SLACK_WEBHOOK_URL: Joi.string().uri().optional().allow(''),
}).options({ allowUnknown: true }); // allow extra vars injected by OS / Docker
