import { Controller, Get, Inject } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckService,
  PrismaHealthIndicator,
  MemoryHealthIndicator,
  DiskHealthIndicator,
} from '@nestjs/terminus';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { Public } from '../../common/decorators/public.decorator';
import { PrismaService } from '../../prisma/prisma.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private health: HealthCheckService,
    private prismaHealth: PrismaHealthIndicator,
    private memory: MemoryHealthIndicator,
    private disk: DiskHealthIndicator,
    private prisma: PrismaService,
    @InjectQueue('notifications') private notifQueue: Queue,
  ) {}

  // ── Full health check (all probes) ─────────────────────────────────────────
  @Public()
  @Get()
  @HealthCheck()
  @ApiOperation({ summary: 'Full platform health check (DB, memory, disk, queue)' })
  check() {
    return this.health.check([
      // 1. PostgreSQL
      () => this.prismaHealth.pingCheck('database', this.prisma),

      // 2. Heap memory < 512 MB
      () => this.memory.checkHeap('memory_heap', 512 * 1024 * 1024),

      // 3. RSS memory < 1 GB
      () => this.memory.checkRSS('memory_rss', 1024 * 1024 * 1024),

      // 4. Disk usage < 90% on root
      () => this.disk.checkStorage('disk', { path: '/', thresholdPercent: 0.9 }),

      // 5. Bull queue (Redis connectivity via queue ping)
      async () => {
        const client = await this.notifQueue.client;
        const pong = await client.ping();
        return {
          redis: {
            status: pong === 'PONG' ? 'up' : 'down',
          },
        };
      },
    ]);
  }

  // ── Liveness probe (only checks process is alive — no DB) ─────────────────
  @Public()
  @Get('live')
  @ApiOperation({ summary: 'Liveness probe — always 200 if process is running' })
  live() {
    return { status: 'ok', ts: new Date().toISOString() };
  }

  // ── Readiness probe (DB + Redis only) ─────────────────────────────────────
  @Public()
  @Get('ready')
  @HealthCheck()
  @ApiOperation({ summary: 'Readiness probe — DB + Redis must be reachable' })
  ready() {
    return this.health.check([
      () => this.prismaHealth.pingCheck('database', this.prisma),
      async () => {
        const client = await this.notifQueue.client;
        const pong = await client.ping();
        return { redis: { status: pong === 'PONG' ? 'up' : 'down' } };
      },
    ]);
  }
}
