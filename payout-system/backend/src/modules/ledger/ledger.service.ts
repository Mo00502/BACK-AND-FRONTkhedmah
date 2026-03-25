import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { LedgerType } from '@prisma/client';

@Injectable()
export class LedgerService {
  private readonly logger = new Logger(LedgerService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Record an immutable ledger entry.
   * Ledger entries are append-only — never updated or deleted.
   */
  async record(
    type: LedgerType,
    referenceId: string,
    amount: number,
    orderId?: string,
    description?: string,
    metadata?: any,
  ) {
    const entry = await this.prisma.ledgerEntry.create({
      data: {
        type,
        referenceId,
        amount,
        orderId: orderId ?? null,
        description: description ?? null,
        metadata: metadata ?? null,
      },
    });

    this.logger.debug(
      `Ledger [${type}] ref=${referenceId} amount=${amount} order=${orderId ?? 'N/A'}`,
    );

    return entry;
  }

  /**
   * Get all ledger entries for a specific order.
   */
  async getOrderLedger(orderId: string) {
    return this.prisma.ledgerEntry.findMany({
      where: { orderId },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Get a financial summary aggregated by ledger type.
   * Useful for admin financial reporting.
   */
  async getFinancialSummary(): Promise<Record<string, { count: number; total: number }>> {
    const entries = await this.prisma.ledgerEntry.groupBy({
      by: ['type'],
      _count: { id: true },
      _sum: { amount: true },
    });

    const summary: Record<string, { count: number; total: number }> = {};

    for (const entry of entries) {
      summary[entry.type] = {
        count: entry._count.id,
        total: Number(entry._sum.amount ?? 0),
      };
    }

    return summary;
  }

  /**
   * Get ledger entries by reference ID.
   */
  async getByReference(referenceId: string) {
    return this.prisma.ledgerEntry.findMany({
      where: { referenceId },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Get recent ledger entries with optional type filter.
   */
  async getRecent(limit = 50, type?: LedgerType) {
    return this.prisma.ledgerEntry.findMany({
      where: type ? { type } : undefined,
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }
}
