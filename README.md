# Khedmah — خدمة

Home-services marketplace for Saudi Arabia.

## Structure

```
khedmah/
├── backend/    # NestJS 10 + Prisma 5 + PostgreSQL 16
└── frontend/   # 36-page HTML/CSS/JS demo (Bootstrap 5 RTL + Alpine.js)
```

## Quick Start

### Backend
```bash
cd backend
cp .env.example .env   # fill in DB / Redis / JWT / etc.
npm install
npx prisma migrate dev
npm run start:dev
# API available at http://localhost:3000/api/v1
# Swagger docs at http://localhost:3000/api/v1/docs
```

### Frontend
```bash
cd frontend
npx serve . -p 3001
# Open http://localhost:3001/INDEX.html
```

## Scripts (from root)

| Command | Description |
|---|---|
| `npm run backend:dev` | Start backend in watch mode |
| `npm run backend:build` | Compile TypeScript |
| `npm run backend:test` | Run 196 unit tests |
| `npm run backend:test:e2e` | Run e2e tests (needs DB + Redis) |
| `npm run frontend:serve` | Serve frontend on port 3001 |

## Tech Stack

**Backend:** NestJS · Prisma · PostgreSQL · Redis · BullMQ · JWT · Socket.io · Winston · Sentry

**Frontend:** Bootstrap 5 RTL · Alpine.js v3 · Tajawal font (all CDN, no build step)

## Demo Credentials

| Role | Email | Password |
|---|---|---|
| Admin | admin@khedmah.sa | Demo@12345 |
| Customer | customer@demo.sa | Demo@12345 |
| Provider | khalid@demo.sa | Demo@12345 |
