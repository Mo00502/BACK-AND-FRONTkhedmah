import { Controller, Post, Get, Body, Param, Headers, Req, UseGuards, RawBodyRequest } from '@nestjs/common';
import { Request } from 'express';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { PaymentsService } from './payments.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { UserRole } from '@prisma/client';
import { IsString, IsEnum, IsOptional, IsObject } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { PaymentMethod } from '@prisma/client';
import {
  ThrottleStrict,
  ThrottleDefault,
  ThrottleRelaxed,
  SkipThrottle,
} from '../../common/decorators/throttle.decorator';

class InitiatePaymentDto {
  @ApiProperty({ enum: PaymentMethod })
  @IsEnum(PaymentMethod)
  method: PaymentMethod;

  @ApiProperty({
    required: false,
    description: 'Set true when provider will purchase materials for the job',
  })
  @IsOptional()
  hasMaterials?: boolean;

  @ApiProperty({
    required: false,
    description: 'Estimated materials cost in SAR (required when hasMaterials=true)',
  })
  @IsOptional()
  materialsEstimate?: number;
}

class RefundPaymentDto {
  @ApiProperty()
  @IsString()
  reason: string;
}

class MaterialsAdjustmentPaymentDto {
  @ApiProperty({ description: 'ID of the approved MaterialsAdjustmentRequest' })
  @IsString()
  adjustmentId: string;

  @ApiProperty({ enum: PaymentMethod })
  @IsEnum(PaymentMethod)
  method: PaymentMethod;
}

class WebhookDto {
  @ApiProperty()
  @IsString()
  type: string;

  @ApiProperty()
  @IsObject()
  data: Record<string, any>;
}

@ApiTags('payments')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('payments')
export class PaymentsController {
  constructor(private payments: PaymentsService) {}

  @Post('requests/:requestId/pay')
  @Roles(UserRole.CUSTOMER)
  @ApiBearerAuth()
  @ThrottleStrict() // 10/min — sensitive financial write
  @ApiOperation({ summary: 'Initiate payment for an accepted request' })
  initiate(
    @Param('requestId') requestId: string,
    @CurrentUser('id') customerId: string,
    @Body() dto: InitiatePaymentDto,
  ) {
    return this.payments.initiatePayment(
      customerId,
      requestId,
      dto.method,
      dto.hasMaterials ?? false,
      dto.materialsEstimate ?? 0,
    );
  }

  @Post('requests/:requestId/release')
  @Roles(UserRole.CUSTOMER)
  @ApiBearerAuth()
  @ThrottleStrict() // 10/min — escrow release is irreversible
  @ApiOperation({ summary: 'Release escrow payment to provider (confirm service completion)' })
  release(@Param('requestId') requestId: string, @CurrentUser('id') customerId: string) {
    return this.payments.releaseEscrow(customerId, requestId);
  }

  @Get(':paymentId/status')
  @Roles(UserRole.CUSTOMER)
  @ApiBearerAuth()
  @ThrottleRelaxed()
  @ApiOperation({ summary: 'Get payment status by ID' })
  getStatus(@Param('paymentId') paymentId: string, @CurrentUser('id') customerId: string) {
    return this.payments.getPaymentStatus(customerId, paymentId);
  }

  @Get('requests/:requestId/escrow')
  @Roles(UserRole.CUSTOMER, UserRole.PROVIDER)
  @ApiBearerAuth()
  @ThrottleRelaxed()
  @ApiOperation({ summary: 'Get escrow status for a request' })
  getEscrow(@Param('requestId') requestId: string, @CurrentUser('id') userId: string) {
    return this.payments.getEscrowStatus(requestId, userId);
  }

  @Post(':paymentId/refund')
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @ApiBearerAuth()
  @ThrottleStrict() // 10/min — refund API calls cost money
  @ApiOperation({ summary: 'Admin: refund a paid payment via Moyasar' })
  refund(
    @Param('paymentId') paymentId: string,
    @CurrentUser('id') adminId: string,
    @Body() dto: RefundPaymentDto,
  ) {
    return this.payments.initiateRefund(adminId, paymentId, dto.reason);
  }

  @Post('materials/adjustment')
  @Roles(UserRole.CUSTOMER)
  @ApiBearerAuth()
  @ThrottleStrict()
  @ApiOperation({ summary: 'Pay for an approved materials budget adjustment request' })
  payMaterialsAdjustment(
    @CurrentUser('id') customerId: string,
    @Body() dto: MaterialsAdjustmentPaymentDto,
  ) {
    return this.payments.initiateMaterialsAdjustmentPayment(customerId, dto.adjustmentId, dto.method);
  }

  @Public()
  @Post('webhook/moyasar')
  @SkipThrottle() // Moyasar calls this — never throttle
  @ApiOperation({ summary: 'Moyasar payment webhook (Moyasar calls this)' })
  webhook(
    @Req() req: RawBodyRequest<Request>,
    @Body() payload: WebhookDto,
    @Headers('x-moyasar-signature') sig: string,
  ) {
    return this.payments.handleWebhook(payload as any, sig, req.rawBody ?? Buffer.from(JSON.stringify(payload)));
  }
}
