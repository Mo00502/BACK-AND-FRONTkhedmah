# Khedmah Backend — Claude Code Instructions

## Project Overview
NestJS REST API for a Saudi home services marketplace with three verticals:
1. **Home Services** — customer posts request, provider quotes, escrow payment
2. **B2B Tender** — company posts tender, providers bid, 2% commission on award
3. **Equipment Rental** — list/rent heavy equipment, 10% platform fee

## Tech Stack
- **Framework:** NestJS 10 + TypeScript
- **ORM:** Prisma 5 + PostgreSQL 16
- **Queue:** BullMQ backed by Redis 7
- **Cache:** `@nestjs/cache-manager` + Redis
- **Auth:** JWT (15m access) + Refresh tokens (30d), email + password (bcrypt), email verification link, password reset link
- **Payments:** Moyasar (Saudi payment gateway) — card, STC Pay, Apple Pay
- **Push:** Firebase Admin SDK (lazy init)
- **Storage:** S3-compatible (AWS or Cloudflare R2)
- **Rate Limiting:** `@nest-lab/throttler-storage-redis` — Redis-backed, shared across instances

## Critical Architecture Decisions

### Split-Payment Model
Every service order supports two independent financial records:
- **`Escrow`** — service fee, `HELD → RELEASED` only after customer confirms completion
- **`MaterialsPayment`** — materials budget, `PAID_AVAILABLE` immediately for provider purchases

**Never** combine these two amounts into a single record. The `Payment.amount` is the total charged to Moyasar, but `Payment.serviceAmount` and `Payment.materialsAmount` are the split. The webhook handler in `PaymentsService._confirmPayment()` does the split.

### Module Structure
```
src/modules/
  auth/               email + password + JWT
  users/              User CRUD
  providers/          Provider profiles + earnings dashboard
  services/           Service catalog (24 categories)
  requests/           Service requests + quotes
  payments/           Moyasar integration + escrow release
  materials-payment/  Materials budget — usage logs, receipts, reconciliation
  wallet/             User wallet + transaction history
  companies/          B2B company profiles
  tenders/            Tender + bidding + commissions
  equipment/          Equipment marketplace + rentals
  notifications/      FCM push + in-app
  files/              S3 upload/download
  reviews/            Ratings
  rewards/            Referral program
  chat/               WebSocket conversations
  tracking/           Real-time order tracking (Socket.io /tracking namespace)
  schedule/           Provider weekly schedule + vacations
  favourites/         Saved providers/equipment
  disputes/           Dispute filing + evidence
  promotions/         Promo codes (PERCENT/FIXED, per-user limits)
  portfolio/          Provider portfolio + certifications
  reports/            Weekly email report (cron Monday 04:00)
  leaderboard/        Provider rankings + badges
  audit/              Immutable audit log
  support/            Customer support tickets + SLA
  invoices/           Invoice generation (VAT 15%)
  search/             Unified search + autocomplete
  analytics/          Admin GMV / trends / funnel
  admin/              Platform administration
  health/             /health/live + /health/ready probes
  scheduler/          Scheduled jobs (auto-release, reconcile, expire)
```

### Throttle Profiles
Use these decorators — never raw `@Throttle()`:
```typescript
@ThrottleAuth()     // 5/min  — login, register, password reset
@ThrottleStrict()   // 10/min — payments, escrow release, admin writes
@ThrottleDefault()  // 30/min — standard authenticated actions
@ThrottleRelaxed()  // 300/min — public reads
@SkipThrottle()     // webhooks, health, logout
```

### Role Hierarchy
```
SUPER_ADMIN > ADMIN > SUPPORT > PROVIDER > CUSTOMER
```
Use `@Roles()` decorator from `common/decorators/roles.decorator.ts`.

### Soft Delete
`User`, `ServiceRequest`, `DirectMessage` have `deletedAt` fields.
The Prisma middleware in `prisma.service.ts` auto-filters `deletedAt: null`.
Always use `prisma.$queryRaw` if you need to bypass this filter.

## Running Locally
```bash
# Start dependencies
docker compose up postgres redis -d

# Install + migrate
npm install
npx prisma migrate dev
npx prisma db seed

# Start dev server
npm run start:dev
```

API: http://localhost:3000/api/v1
Swagger: http://localhost:3000/api/docs

## Testing
```bash
npm run test              # unit tests (Jest)
npm run test:e2e          # E2E tests (supertest)
npm run test:cov          # coverage report
```

Test files live next to the service they test (`*.service.spec.ts`).
E2E tests live in `test/`.

## Database
```bash
npx prisma migrate dev --name <migration-name>   # new migration
npx prisma migrate deploy                         # apply in production
npx prisma studio                                 # browse data
```

## Key Business Rules
| Rule | Value |
|------|-------|
| Service platform fee | 15% of escrow on release |
| Tender commission | 2% of awarded amount |
| Equipment fee | 10% of rental value |
| VAT | 15% (Saudi) on all invoices |
| Escrow auto-release | 48 hours after completion (if no dispute) |
| Materials adjustment expiry | 24 hours after provider requests |
| Email verification link | 24 hours |
| Password reset link | 60 minutes |
| JWT access token | 15 minutes |
| JWT refresh token | 30 days |

## CI/CD
- `.github/workflows/ci.yml` — lint → unit tests → build → Docker → deploy
- `.github/workflows/security.yml` — npm audit + Snyk + CodeQL (weekly)
- Docker: 4-stage build in `Dockerfile`, non-root `khedmah` user, `dumb-init`
- Deploy: SSH into server → `prisma migrate deploy` → zero-downtime swap

## Authentication Architecture
No OTP/SMS authentication. Email + password only.
- **Customer:** email, username, password → email verification link → ACTIVE
- **Provider:** email, username, password, phone (contact only) → email verification → doc upload → Admin review → APPROVED
- **Provider status flow:** `PENDING_SUBMISSION → PENDING_REVIEW → UNDER_REVIEW → APPROVED | REJECTED | SUSPENDED`
- Token format: `userId:hexBytes` — split on `:` to avoid full-table scan
- All token hashes stored with bcrypt (never raw tokens in DB)
- Password reset invalidates all active refresh tokens

## Do Not
- Do not store secrets in code — use `ConfigService` and `.env`
- Do not add raw `@Throttle({...})` — use the named profile decorators
- Do not mix `serviceAmount` and `materialsAmount` — they are separate financial records
- Do not skip Prisma migrations — always generate a migration file for schema changes
- Do not use `prisma.$queryRaw` without parameterized inputs (SQL injection risk)
- Do not add `@SkipThrottle()` to financial write endpoints
- Do not use phone number for authentication — it is contact-only for providers
