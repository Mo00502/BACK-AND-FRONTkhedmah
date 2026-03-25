import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CommissionService } from '../commission/commission.service';
import { EscrowService } from '../escrow/escrow.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CreateOrderDto } from './dto/order.dto';
import { OrderStatus, UserRole } from '@prisma/client';

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly commission: CommissionService,
    private readonly escrowService: EscrowService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Create a new service order.
   * Calculates commission breakdown and stores it.
   */
  async create(customerId: string, dto: CreateOrderDto) {
    const commissionResult = this.commission.calculateCommission(dto.totalAmount);

    const order = await this.prisma.$transaction(async (tx) => {
      const newOrder = await tx.order.create({
        data: {
          customerId,
          serviceTitle: dto.serviceTitle,
          description: dto.description,
          totalAmount: dto.totalAmount,
          hasMaterials: dto.hasMaterials ?? false,
          materialsAmount: dto.materialsAmount ?? null,
          address: dto.address,
          scheduledAt: dto.scheduledAt ? new Date(dto.scheduledAt) : null,
          status: OrderStatus.CREATED,
        },
      });

      await tx.commissionBreakdown.create({
        data: {
          orderId: newOrder.id,
          totalAmount: commissionResult.totalAmount,
          commissionRate: commissionResult.commissionRate,
          platformFee: commissionResult.platformFee,
          providerAmount: commissionResult.providerAmount,
          vatAmount: commissionResult.vatAmount,
        },
      });

      return newOrder;
    });

    this.logger.log(`Order created: id=${order.id} customer=${customerId}`);
    return this.getById(order.id);
  }

  /**
   * Get a single order by ID with all relations.
   */
  async getById(id: string) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: {
        customer: {
          select: { id: true, firstName: true, lastName: true, email: true },
        },
        provider: {
          include: {
            user: { select: { id: true, firstName: true, lastName: true, email: true } },
          },
        },
        transaction: true,
        commissionBreakdown: true,
        escrow: true,
      },
    });

    if (!order) throw new NotFoundException(`Order ${id} not found`);
    return order;
  }

  /**
   * Get orders for a user (customer sees their orders, provider sees assigned orders).
   */
  async getMyOrders(userId: string, role: UserRole) {
    if (role === UserRole.CUSTOMER) {
      return this.prisma.order.findMany({
        where: { customerId: userId },
        include: {
          commissionBreakdown: true,
          escrow: true,
          transaction: { select: { status: true, paidAt: true } },
        },
        orderBy: { createdAt: 'desc' },
      });
    }

    if (role === UserRole.PROVIDER) {
      const provider = await this.prisma.provider.findUnique({ where: { userId } });
      if (!provider) throw new NotFoundException('Provider profile not found');

      return this.prisma.order.findMany({
        where: { providerId: provider.id },
        include: {
          customer: { select: { id: true, firstName: true, lastName: true } },
          commissionBreakdown: true,
          escrow: true,
        },
        orderBy: { createdAt: 'desc' },
      });
    }

    // Admin: get all orders
    return this.prisma.order.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        customer: { select: { id: true, firstName: true, lastName: true, email: true } },
        commissionBreakdown: true,
        escrow: true,
      },
    });
  }

  /**
   * Provider accepts an order (CREATED → ACCEPTED).
   */
  async accept(orderId: string, providerUserId: string) {
    const order = await this.getById(orderId);

    if (order.status !== OrderStatus.CREATED) {
      throw new BadRequestException(`Cannot accept order in status: ${order.status}`);
    }

    const provider = await this.prisma.provider.findUnique({ where: { userId: providerUserId } });
    if (!provider) throw new NotFoundException('Provider profile not found');

    const updated = await this.prisma.order.update({
      where: { id: orderId },
      data: {
        status: OrderStatus.ACCEPTED,
        providerId: provider.id,
        acceptedAt: new Date(),
      },
    });

    this.eventEmitter.emit('order.accepted', {
      orderId,
      customerId: order.customerId,
      providerId: provider.id,
    });

    this.logger.log(`Order accepted: id=${orderId} provider=${provider.id}`);
    return updated;
  }

  /**
   * Provider starts work (ACCEPTED → IN_PROGRESS).
   */
  async start(orderId: string, providerUserId: string) {
    const order = await this.getById(orderId);

    const provider = await this.prisma.provider.findUnique({ where: { userId: providerUserId } });
    if (!provider) throw new NotFoundException('Provider profile not found');

    if (order.providerId !== provider.id) {
      throw new ForbiddenException('You are not assigned to this order');
    }

    if (order.status !== OrderStatus.ACCEPTED) {
      throw new BadRequestException(`Cannot start order in status: ${order.status}`);
    }

    const updated = await this.prisma.order.update({
      where: { id: orderId },
      data: {
        status: OrderStatus.IN_PROGRESS,
        startedAt: new Date(),
      },
    });

    this.logger.log(`Order started: id=${orderId}`);
    return updated;
  }

  /**
   * Provider marks work complete (IN_PROGRESS → AWAITING_RELEASE).
   * Customer must confirm before escrow is released.
   */
  async complete(orderId: string, providerUserId: string) {
    const order = await this.getById(orderId);

    const provider = await this.prisma.provider.findUnique({ where: { userId: providerUserId } });
    if (!provider) throw new NotFoundException('Provider profile not found');

    if (order.providerId !== provider.id) {
      throw new ForbiddenException('You are not assigned to this order');
    }

    if (order.status !== OrderStatus.IN_PROGRESS) {
      throw new BadRequestException(`Cannot complete order in status: ${order.status}`);
    }

    const updated = await this.prisma.order.update({
      where: { id: orderId },
      data: {
        status: OrderStatus.AWAITING_RELEASE,
        completedAt: new Date(),
      },
    });

    this.eventEmitter.emit('order.completed', {
      orderId,
      customerId: order.customerId,
      providerId: provider.id,
    });

    this.logger.log(`Order marked complete: id=${orderId} — awaiting customer release`);
    return updated;
  }

  /**
   * Customer confirms and releases escrow (AWAITING_RELEASE → RELEASED).
   */
  async release(orderId: string, customerId: string) {
    const order = await this.getById(orderId);

    if (order.customerId !== customerId) {
      throw new ForbiddenException('Only the customer who placed this order can release it');
    }

    if (order.status !== OrderStatus.AWAITING_RELEASE) {
      throw new BadRequestException(
        `Cannot release order in status: ${order.status}. Order must be AWAITING_RELEASE.`,
      );
    }

    if (!order.escrow) {
      throw new BadRequestException('No escrow found for this order — payment may not be confirmed');
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const updatedOrder = await tx.order.update({
        where: { id: orderId },
        data: {
          status: OrderStatus.RELEASED,
          releasedAt: new Date(),
        },
      });
      return updatedOrder;
    });

    // Release escrow (emits escrow.released event)
    await this.escrowService.release(order.escrow.id);

    this.logger.log(`Order released by customer: id=${orderId}`);
    return updated;
  }

  /**
   * Cancel an order. Refunds escrow if payment was made.
   */
  async cancel(orderId: string, userId: string) {
    const order = await this.getById(orderId);

    // Only customer or admin can cancel
    const cancellableStatuses = [
      OrderStatus.CREATED,
      OrderStatus.ACCEPTED,
      OrderStatus.IN_PROGRESS,
      OrderStatus.AWAITING_RELEASE,
    ];

    if (!cancellableStatuses.includes(order.status)) {
      throw new BadRequestException(`Cannot cancel order in status: ${order.status}`);
    }

    // Verify ownership (customer) — admin bypass handled by roles guard
    if (order.customerId !== userId) {
      const provider = await this.prisma.provider.findUnique({ where: { userId } });
      if (!provider || order.providerId !== provider.id) {
        throw new ForbiddenException('You cannot cancel this order');
      }
    }

    await this.prisma.order.update({
      where: { id: orderId },
      data: { status: OrderStatus.CANCELLED },
    });

    // Refund escrow if it exists
    if (order.escrow && order.escrow.status === 'HELD') {
      await this.escrowService.refund(order.escrow.id);
    }

    this.eventEmitter.emit('order.cancelled', {
      orderId,
      customerId: order.customerId,
    });

    this.logger.log(`Order cancelled: id=${orderId}`);
    return { message: 'Order cancelled successfully', orderId };
  }
}
