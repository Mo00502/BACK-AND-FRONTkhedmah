import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { OrdersService } from './orders.service';
import { CreateOrderDto } from './dto/order.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UserRole } from '@prisma/client';

@ApiTags('orders')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('orders')
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Post()
  @Roles(UserRole.CUSTOMER)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new service order (Customer only)' })
  @ApiResponse({ status: 201, description: 'Order created with commission breakdown' })
  @ApiResponse({ status: 403, description: 'Only customers can create orders' })
  async createOrder(
    @CurrentUser('id') customerId: string,
    @Body() dto: CreateOrderDto,
  ) {
    return this.ordersService.create(customerId, dto);
  }

  @Get('my')
  @ApiOperation({ summary: 'Get my orders (Customer: own orders, Provider: assigned orders)' })
  @ApiResponse({ status: 200, description: 'List of orders' })
  async getMyOrders(
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: UserRole,
  ) {
    return this.ordersService.getMyOrders(userId, role);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single order by ID' })
  @ApiResponse({ status: 200, description: 'Order details' })
  @ApiResponse({ status: 404, description: 'Order not found' })
  async getOrder(@Param('id') id: string) {
    return this.ordersService.getById(id);
  }

  @Patch(':id/accept')
  @Roles(UserRole.PROVIDER)
  @ApiOperation({ summary: 'Provider accepts an order (CREATED → ACCEPTED)' })
  @ApiResponse({ status: 200, description: 'Order accepted' })
  @ApiResponse({ status: 400, description: 'Order not in CREATED status' })
  async acceptOrder(
    @Param('id') orderId: string,
    @CurrentUser('id') providerUserId: string,
  ) {
    return this.ordersService.accept(orderId, providerUserId);
  }

  @Patch(':id/start')
  @Roles(UserRole.PROVIDER)
  @ApiOperation({ summary: 'Provider starts work (ACCEPTED → IN_PROGRESS)' })
  @ApiResponse({ status: 200, description: 'Work started' })
  async startOrder(
    @Param('id') orderId: string,
    @CurrentUser('id') providerUserId: string,
  ) {
    return this.ordersService.start(orderId, providerUserId);
  }

  @Patch(':id/complete')
  @Roles(UserRole.PROVIDER)
  @ApiOperation({ summary: 'Provider marks work complete (IN_PROGRESS → AWAITING_RELEASE)' })
  @ApiResponse({ status: 200, description: 'Order awaiting customer release' })
  async completeOrder(
    @Param('id') orderId: string,
    @CurrentUser('id') providerUserId: string,
  ) {
    return this.ordersService.complete(orderId, providerUserId);
  }

  @Patch(':id/release')
  @Roles(UserRole.CUSTOMER)
  @ApiOperation({ summary: 'Customer confirms work and releases escrow (AWAITING_RELEASE → RELEASED)' })
  @ApiResponse({ status: 200, description: 'Escrow released to provider' })
  @ApiResponse({ status: 400, description: 'Order not in AWAITING_RELEASE status' })
  async releaseOrder(
    @Param('id') orderId: string,
    @CurrentUser('id') customerId: string,
  ) {
    return this.ordersService.release(orderId, customerId);
  }

  @Patch(':id/cancel')
  @ApiOperation({ summary: 'Cancel an order (refunds escrow if payment was made)' })
  @ApiResponse({ status: 200, description: 'Order cancelled' })
  async cancelOrder(
    @Param('id') orderId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.ordersService.cancel(orderId, userId);
  }
}
