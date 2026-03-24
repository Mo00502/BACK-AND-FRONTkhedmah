import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { CompaniesService } from './companies.service';
import { CreateCompanyDto, UpdateCompanyDto } from './dto/company.dto';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import {
  ThrottleDefault,
  ThrottleRelaxed,
  ThrottleStrict,
} from '../../common/decorators/throttle.decorator';
import { UserRole } from '@prisma/client';

@ApiTags('companies')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('companies')
export class CompaniesController {
  constructor(private companies: CompaniesService) {}

  @Public()
  @Get()
  @ThrottleRelaxed()
  @ApiOperation({ summary: 'List all verified companies (public)' })
  findAll(@Query() dto: PaginationDto & { city?: string }) {
    return this.companies.findAll({ ...dto, verified: true } as any);
  }

  @ApiBearerAuth()
  @Get('me/profile')
  @Roles(UserRole.PROVIDER, UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @ThrottleDefault()
  @ApiOperation({ summary: 'Get my company profile' })
  mine(@CurrentUser('id') userId: string) {
    return this.companies.getMyCompany(userId);
  }

  @Public()
  @Get(':id')
  @ThrottleRelaxed()
  @ApiOperation({ summary: 'Get company profile by ID (public)' })
  getOne(@Param('id') id: string) {
    return this.companies.getById(id);
  }

  @ApiBearerAuth()
  @Post()
  @Roles(UserRole.PROVIDER, UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @ThrottleStrict()
  @ApiOperation({ summary: 'Create a company profile' })
  create(@CurrentUser('id') userId: string, @Body() dto: CreateCompanyDto) {
    return this.companies.create(userId, dto);
  }

  @ApiBearerAuth()
  @Patch(':id')
  @Roles(UserRole.PROVIDER, UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @ThrottleDefault()
  @ApiOperation({ summary: 'Update company profile (owner only)' })
  update(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Body() dto: UpdateCompanyDto,
  ) {
    return this.companies.update(id, userId, dto);
  }

  @ApiBearerAuth()
  @Delete(':id')
  @Roles(UserRole.PROVIDER, UserRole.SUPER_ADMIN)
  @ThrottleStrict()
  @ApiOperation({ summary: 'Delete company profile (owner only, no active tenders)' })
  remove(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.companies.delete(id, userId);
  }
}
