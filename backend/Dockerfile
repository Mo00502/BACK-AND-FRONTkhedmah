# ══════════════════════════════════════════════════════════════════════════════
# Stage 1 — deps: install ALL deps (including devDependencies for build)
# ══════════════════════════════════════════════════════════════════════════════
FROM node:20-alpine AS deps
WORKDIR /app

# Install dumb-init (PID 1 signal handler) and openssl (Prisma needs it)
RUN apk add --no-cache dumb-init openssl

COPY package*.json ./
# Frozen lockfile — fail if package-lock.json is out of sync
RUN npm ci --frozen-lockfile

# ══════════════════════════════════════════════════════════════════════════════
# Stage 2 — builder: generate Prisma client + compile TypeScript
# ══════════════════════════════════════════════════════════════════════════════
FROM deps AS builder
WORKDIR /app

ARG BUILD_DATE
ARG GIT_SHA

COPY . .

# Generate Prisma client (uses node_modules from deps stage)
RUN npx prisma generate

# Compile TypeScript → dist/
RUN npm run build

# ══════════════════════════════════════════════════════════════════════════════
# Stage 3 — prod-deps: production-only node_modules (no devDependencies)
# ══════════════════════════════════════════════════════════════════════════════
FROM node:20-alpine AS prod-deps
WORKDIR /app

RUN apk add --no-cache openssl

COPY package*.json ./
# --omit=dev drops devDependencies; --frozen-lockfile for reproducibility
RUN npm ci --frozen-lockfile --omit=dev && npm cache clean --force

# ══════════════════════════════════════════════════════════════════════════════
# Stage 4 — production: minimal runtime image
# ══════════════════════════════════════════════════════════════════════════════
FROM node:20-alpine AS production

ARG BUILD_DATE
ARG GIT_SHA

LABEL org.opencontainers.image.title="Khedmah API"
LABEL org.opencontainers.image.description="Saudi Home Services Marketplace — NestJS API"
LABEL org.opencontainers.image.created="${BUILD_DATE}"
LABEL org.opencontainers.image.revision="${GIT_SHA}"

# Runtime dependencies only
RUN apk add --no-cache dumb-init openssl curl

WORKDIR /app

# Non-root user for security
RUN addgroup -g 1001 -S khedmah && \
    adduser  -u 1001 -S khedmah -G khedmah

# Copy production node_modules (no devDeps)
COPY --from=prod-deps  --chown=khedmah:khedmah /app/node_modules ./node_modules

# Copy compiled application
COPY --from=builder    --chown=khedmah:khedmah /app/dist          ./dist

# Copy Prisma generated client + schema (needed at runtime for migrations)
COPY --from=builder    --chown=khedmah:khedmah /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder    --chown=khedmah:khedmah /app/prisma        ./prisma

# Copy only what's needed at runtime
COPY --chown=khedmah:khedmah package*.json ./

USER khedmah

EXPOSE 3000

# Healthcheck uses /health/live (excluded from global prefix, always fast)
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -f http://localhost:3000/health/live || exit 1

# dumb-init handles signals properly (graceful shutdown on SIGTERM)
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/main.js"]
