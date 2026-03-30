import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { AddressesService } from './addresses.service';
import { CreateAddressDto, UpdateAddressDto } from './dto/address.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UserRole } from '@prisma/client';
import { ThrottleDefault, ThrottleRelaxed } from '../../common/decorators/throttle.decorator';

@ApiTags('addresses')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.CUSTOMER)
@Controller('users/me/addresses')
export class AddressesController {
  constructor(private addresses: AddressesService) {}

  @Get()
  @ThrottleRelaxed()
  @ApiOperation({ summary: 'List my saved addresses' })
  list(@CurrentUser('id') userId: string) {
    return this.addresses.list(userId);
  }

  @Post()
  @ThrottleDefault()
  @ApiOperation({ summary: 'Save a new address' })
  create(@CurrentUser('id') userId: string, @Body() dto: CreateAddressDto) {
    return this.addresses.create(userId, dto);
  }

  @Patch(':id')
  @ThrottleDefault()
  @ApiOperation({ summary: 'Update a saved address' })
  update(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: UpdateAddressDto,
  ) {
    return this.addresses.update(userId, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ThrottleDefault()
  @ApiOperation({ summary: 'Delete a saved address' })
  remove(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.addresses.remove(userId, id);
  }

  @Patch(':id/default')
  @ThrottleDefault()
  @ApiOperation({ summary: 'Set address as default' })
  setDefault(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.addresses.setDefault(userId, id);
  }
}
