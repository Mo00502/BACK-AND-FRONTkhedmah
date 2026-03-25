import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Headers,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiHeader,
} from '@nestjs/swagger';
import { IsString, IsObject } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { PaymentsService } from './payments.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { UserRole } from '@prisma/client';
import { MoyasarSource } from './moyasar.service';

class InitiatePaymentDto {
  @ApiProperty({ example: 'order-uuid-here' })
  @IsString()
  orderId: string;

  @ApiProperty({
    example: { type: 'creditcard', name: 'Ahmad Ali', number: '4111111111111111', cvc: '123', month: '12', year: '2026' },
  })
  @IsObject()
  source: MoyasarSource;
}

@ApiTags('payments')
@Controller('payments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.CUSTOMER)
  @Post('initiate')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Initiate a Moyasar payment for an order (Customer only)' })
  @ApiResponse({ status: 201, description: 'Payment initiated — redirect customer to gateway URL' })
  @ApiResponse({ status: 400, description: 'Order not payable' })
  @ApiResponse({ status: 409, description: 'Already paid' })
  async initiatePayment(
    @CurrentUser('id') customerId: string,
    @Body() dto: InitiatePaymentDto,
  ) {
    return this.paymentsService.createPaymentRequest(dto.orderId, customerId, dto.source);
  }

  @Public()
  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Moyasar webhook endpoint — do not call manually' })
  @ApiHeader({ name: 'x-moyasar-signature', description: 'HMAC SHA256 signature' })
  @ApiResponse({ status: 200, description: 'Webhook processed' })
  async webhook(
    @Body() payload: any,
    @Headers('x-moyasar-signature') signature: string,
  ) {
    await this.paymentsService.handleWebhook(payload, signature);
    return { received: true };
  }

  @UseGuards(JwtAuthGuard)
  @Get('status/:orderId')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get payment status for an order' })
  @ApiResponse({ status: 200, description: 'Transaction status' })
  @ApiResponse({ status: 404, description: 'No transaction for order' })
  async getStatus(@Param('orderId') orderId: string) {
    return this.paymentsService.getStatus(orderId);
  }
}
