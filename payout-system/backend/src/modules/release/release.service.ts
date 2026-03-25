import { Injectable, Logger, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { EscrowService } from '../escrow/escrow.service';
import { ConfigService } from '@nestjs/config';
import { OrderStatus, EscrowStatus } from '@prisma/client';

@Injectable()
export class ReleaseService {
  private readonly logger = new Logger(ReleaseService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly escrowService: EscrowService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Cron: auto-release escrow for orders AWAITING_RELEASE after configured hours.
   * Runs every hour.
   */
  @Cron('0 */1 * * *')
  async autoRelease(): Promise<void> {
    const autoReleaseHours = parseInt(
      this.configService.get<string>('ESCROW_AUTO_RELEASE_HOURS', '48'),
      10,
    );

    const cutoffTime = new Date();
    cutoffTime.setHours(cutoffTime.getHours() - autoReleaseHours);

    this.logger.log(
      `Auto-release cron: checking orders AWAITING_RELEASE completed before ${cutoffTime.toISOString()}`,
    );

    // Find orders that have been AWAITING_RELEASE for longer than the configured hours
    const eligibleOrders = await this.prisma.order.findMany({
      where: {
        status: OrderStatus.AWAITING_RELEASE,
        completedAt: {
          lte: cutoffTime,
        },
      },
      include: {
        escrow: true,
      },
    });

    this.logger.log(`Auto-release: found ${eligibleOrders.length} eligible orders`);

    let releasedCount = 0;
    let failedCount = 0;

    for (const order of eligibleOrders) {
      try {
        if (!order.escrow) {
          this.logger.warn(`Order ${order.id} has no escrow — skipping`);
          continue;
        }

        if (order.escrow.status !== EscrowStatus.HELD) {
          this.logger.warn(
            `Order ${order.id} escrow is ${order.escrow.status} — skipping`,
          );
          continue;
        }

        // Release escrow and update order
        await this.prisma.$transaction(async (tx) => {
          await tx.order.update({
            where: { id: order.id },
            data: {
              status: OrderStatus.RELEASED,
              releasedAt: new Date(),
            },
          });
        });

        await this.escrowService.release(order.escrow.id);

        releasedCount++;
        this.logger.log(
          `Auto-released: order=${order.id} escrow=${order.escrow.id} after ${autoReleaseHours}h`,
        );
      } catch (error) {
        failedCount++;
        this.logger.error(
          `Auto-release failed for order ${order.id}: ${error.message}`,
          error.stack,
        );
      }
    }

    if (eligibleOrders.length > 0) {
      this.logger.log(
        `Auto-release complete: ${releasedCount} released, ${failedCount} failed`,
      );
    }
  }

  /**
   * Manual release triggered by customer (from OrdersService).
   * Validates ownership and order status before delegating to EscrowService.
   */
  async manualRelease(orderId: string, customerId: string): Promise<void> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { escrow: true },
    });

    if (!order) {
      throw new NotFoundException(`Order ${orderId} not found`);
    }

    if (order.customerId !== customerId) {
      throw new ForbiddenException('Only the order customer can release escrow');
    }

    if (order.status !== OrderStatus.AWAITING_RELEASE) {
      throw new BadRequestException(
        `Order must be AWAITING_RELEASE to manually release escrow (current: ${order.status})`,
      );
    }

    if (!order.escrow) {
      throw new BadRequestException('No escrow found for this order');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.order.update({
        where: { id: orderId },
        data: {
          status: OrderStatus.RELEASED,
          releasedAt: new Date(),
        },
      });
    });

    await this.escrowService.release(order.escrow.id);

    this.logger.log(`Manual release: order=${orderId} by customer=${customerId}`);
  }
}
