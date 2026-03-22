import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { ServicesService } from './services.service';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { Public } from '../../common/decorators/public.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { ThrottleRelaxed, ThrottleDefault } from '../../common/decorators/throttle.decorator';

@ApiTags('services')
@UseGuards(JwtAuthGuard)
@Controller('services')
export class ServicesController {
  constructor(private services: ServicesService) {}

  @Public()
  @ThrottleRelaxed()
  @Get('categories')
  @ApiOperation({ summary: 'Get all service categories with their services' })
  getCategories() {
    return this.services.findAllCategories();
  }

  @Public()
  @ThrottleRelaxed()
  @Get()
  @ApiOperation({ summary: 'List all active services' })
  @ApiQuery({ name: 'categoryId', required: false })
  findAll(@Query() dto: PaginationDto & { categoryId?: string }) {
    return this.services.findAll(dto);
  }

  @Public()
  @ThrottleRelaxed()
  @Get(':id')
  @ApiOperation({ summary: 'Get service by ID' })
  findOne(@Param('id') id: string) {
    return this.services.findById(id);
  }

  @ApiBearerAuth()
  @ThrottleDefault()
  @Get(':id/providers')
  @ApiOperation({ summary: 'Get providers offering a specific service' })
  @ApiQuery({ name: 'city', required: false })
  getProviders(@Param('id') serviceId: string, @Query() dto: PaginationDto & { city?: string }) {
    return this.services.findProvidersByService(serviceId, dto);
  }
}
