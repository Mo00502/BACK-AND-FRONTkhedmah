import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { SearchService } from './search.service';
import { Public } from '../../common/decorators/public.decorator';
import { ThrottleRelaxed } from '../../common/decorators/throttle.decorator';

@ApiTags('search')
@Controller('search')
export class SearchController {
  constructor(private search: SearchService) {}

  @ThrottleRelaxed()
  @Public()
  @Get()
  @ApiOperation({ summary: 'Unified search across providers, services, tenders & equipment' })
  @ApiQuery({ name: 'q', required: true })
  @ApiQuery({ name: 'city', required: false })
  @ApiQuery({ name: 'region', required: false })
  @ApiQuery({ name: 'category', required: false })
  @ApiQuery({ name: 'minPrice', required: false, type: Number })
  @ApiQuery({ name: 'maxPrice', required: false, type: Number })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  searchAll(
    @Query('q') q: string,
    @Query('city') city?: string,
    @Query('region') region?: string,
    @Query('category') category?: string,
    @Query('minPrice') minPrice?: number,
    @Query('maxPrice') maxPrice?: number,
    @Query('page') page = 1,
    @Query('limit') limit = 10,
  ) {
    return this.search.searchAll({
      q,
      city,
      region,
      category,
      minPrice,
      maxPrice,
      page: +page,
      limit: +limit,
    });
  }

  @ThrottleRelaxed()
  @Public()
  @Get('providers')
  @ApiOperation({ summary: 'Search providers only' })
  searchProviders(
    @Query('q') q: string,
    @Query('city') city?: string,
    @Query('page') page = 1,
    @Query('limit') limit = 10,
  ) {
    return this.search.searchProviders({ q, city, page: +page, limit: +limit });
  }

  @ThrottleRelaxed()
  @Public()
  @Get('tenders')
  @ApiOperation({ summary: 'Search open tenders' })
  searchTenders(
    @Query('q') q: string,
    @Query('region') region?: string,
    @Query('minPrice') minPrice?: number,
    @Query('maxPrice') maxPrice?: number,
    @Query('page') page = 1,
    @Query('limit') limit = 10,
  ) {
    return this.search.searchTenders({ q, region, minPrice, maxPrice, page: +page, limit: +limit });
  }

  @ThrottleRelaxed()
  @Public()
  @Get('equipment')
  @ApiOperation({ summary: 'Search available equipment' })
  searchEquipment(
    @Query('q') q: string,
    @Query('region') region?: string,
    @Query('category') category?: string,
    @Query('minPrice') minPrice?: number,
    @Query('maxPrice') maxPrice?: number,
    @Query('page') page = 1,
    @Query('limit') limit = 10,
  ) {
    return this.search.searchEquipment({
      q,
      region,
      category,
      minPrice,
      maxPrice,
      page: +page,
      limit: +limit,
    });
  }

  @ThrottleRelaxed()
  @Public()
  @Get('autocomplete')
  @ApiOperation({ summary: 'Autocomplete suggestions for search bar' })
  @ApiQuery({ name: 'q', required: true })
  autocomplete(@Query('q') q: string) {
    return this.search.autocomplete(q);
  }
}
