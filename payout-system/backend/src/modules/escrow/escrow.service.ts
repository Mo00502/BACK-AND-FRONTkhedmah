import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { EscrowStatus, LedgerType } from '@prisma/client';

@Injectable()
export class EscrowService {
  private readonly logger = new Logger(EscrowService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Create an escrow record for a paid order.
   * Escrow holds the provider's share until customer confirms completion.
   */
  async create(orderId: string, providerAmount: number) {
    // Ensure no duplicate escrow
    const existing = await this.prisma.escrow.findUnique({ where: { orderId } });
    if (existing) {
      this.logger.warn(`Escrow already exists for order ${orderId}`);
      return existing;
    }

    const escrow = await this.prisma.escrow.create({
      data: {
        orderId,
        providerAmount,
        status: EscrowStatus.HELD,
      },
    });

    await this.ledger.record(
      LedgerType.ESCROW_HELD,
      escrow.id,
      providerAmount,
      orderId,
      `Escrow held for order ${orderId}`,
    );

    this.logger.log(`Escrow created: id=${escrow.id} order=${orderId} amount=${providerAmount}`);

    return escrow;
  }

  /**
   * Release escrow — provider funds move from escrow → pending wallet.
   * Emits 'escrow.released' for downstream processing.
   */
  async release(escrowId: string) {
    const escrow = await this.prisma.escrow.findUnique({
      where: { id: escrowId },
      include: { order: { include: { provider: true } } },
    });

    if (!escrow) {
      throw new NotFoundException(`Escrow ${escrowId} not found`);
    }

    if (escrow.status !== EscrowStatus.HELD) {
      throw new BadRequestException(
        `Escrow ${escrowId} is not in HELD status (current: ${escrow.status})`,
      );
    }

    const released = await this.prisma.escrow.update({
      where: { id: escrowId },
      data: {
        status: EscrowStatus.RELEASED,
        releasedAt: new Date(),
      },
    });

    await this.ledger.record(
      LedgerType.ESCROW_RELEASED,
      escrowId,
      Number(escrow.providerAmount),
      escrow.orderId,
      `Escrow released for order ${escrow.orderId}`,
    );

    this.eventEmitter.emit('escrow.released', {
      escrowId,
      orderId: escrow.orderId,
      providerId: escrow.order.providerId,
      providerUserId: escrow.order.provider?.userId,
      amount: Number(escrow.providerAmount),
    });

    this.logger.log(`Escrow released: id=${escrowId} amount=${escrow.providerAmount}`);

    return released;
  }

  /**
   * Refund escrow — customer funds returned.
   * Emits 'escrow.refunded' for Moyasar refund processing.
   */
  async refund(escrowId: string) {
    const escrow = await this.prisma.escrow.findUnique({
      where: { id: escrowId },
      include: { order: true },
    });

    if (!escrow) {
      throw new NotFoundException(`Escrow ${escrowId} not found`);
    }

    if (escrow.status !== EscrowStatus.HELD) {
      throw new BadRequestException(
        `Escrow ${escrowId} cannot be refunded (current: ${escrow.status})`,
      );
    }

    const refunded = await this.prisma.escrow.update({
      where: { id: escrowId },
      data: {
        status: EscrowStatus.REFUNDED,
        refundedAt: new Date(),
      },
    });

    await this.ledger.record(
      LedgerType.REFUND_ISSUED,
      escrowId,
      Number(escrow.providerAmount),
      escrow.orderId,
      `Escrow refunded for order ${escrow.orderId}`,
    );

    this.eventEmitter.emit('escrow.refunded', {
      escrowId,
      orderId: escrow.orderId,
      amount: Number(escrow.providerAmount),
    });

    this.logger.log(`Escrow refunded: id=${escrowId}`);

    return refunded;
  }

  /**
   * Get escrow record by order ID.
   */
  async getByOrder(orderId: string) {
    const escrow = await this.prisma.escrow.findUnique({ where: { orderId } });
    if (!escrow) {
      throw new NotFoundException(`No escrow found for order ${orderId}`);
    }
    return escrow;
  }

  /**
   * Get escrow by its own ID.
   */
  async getById(escrowId: string) {
    const escrow = await this.prisma.escrow.findUnique({ where: { id: escrowId } });
    if (!escrow) {
      throw new NotFoundException(`Escrow ${escrowId} not found`);
    }
    return escrow;
  }
}
