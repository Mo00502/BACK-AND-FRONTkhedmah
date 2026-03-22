import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { InvoicesService } from './invoices.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ThrottleDefault } from '../../common/decorators/throttle.decorator';

@ApiTags('invoices')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('invoices')
export class InvoicesController {
  constructor(private invoices: InvoicesService) {}

  @Get()
  @ThrottleDefault()
  @ApiOperation({ summary: 'List all my invoices across all verticals' })
  myInvoices(@CurrentUser('id') userId: string) {
    return this.invoices.listMyInvoices(userId);
  }

  @Get('service/:requestId')
  @ThrottleDefault()
  @ApiOperation({ summary: 'Get home-service invoice by request ID' })
  serviceInvoice(@CurrentUser('id') userId: string, @Param('requestId') requestId: string) {
    return this.invoices.getServiceInvoice(userId, requestId);
  }

  @Get('tender/:commissionId')
  @ThrottleDefault()
  @ApiOperation({ summary: 'Get tender commission invoice' })
  tenderInvoice(@CurrentUser('id') userId: string, @Param('commissionId') commissionId: string) {
    return this.invoices.getTenderCommissionInvoice(userId, commissionId);
  }

  @Get('equipment/:rentalId')
  @ThrottleDefault()
  @ApiOperation({ summary: 'Get equipment rental invoice' })
  equipmentInvoice(@CurrentUser('id') userId: string, @Param('rentalId') rentalId: string) {
    return this.invoices.getEquipmentInvoice(userId, rentalId);
  }
}
