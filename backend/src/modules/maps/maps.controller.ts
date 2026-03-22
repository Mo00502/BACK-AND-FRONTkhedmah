import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import { ThrottleStrict } from '../../common/decorators/throttle.decorator';
import { MapsService } from './maps.service';

@ApiTags('maps')
@Controller('maps')
export class MapsController {
  constructor(private readonly maps: MapsService) {}

  /**
   * Address autocomplete — used by the frontend quote-request form.
   * Restricted to Saudi Arabia, returns Arabic suggestions.
   */
  @Get('autocomplete')
  @Public()
  @ThrottleStrict()
  @ApiOperation({ summary: 'Address autocomplete (Saudi Arabia, Arabic)' })
  @ApiQuery({ name: 'q', description: 'Search query' })
  @ApiQuery({
    name: 'sessionToken',
    description: 'Client-generated session token (groups billable requests)',
  })
  @ApiQuery({ name: 'city', required: false, description: 'Bias results toward this city' })
  async autocomplete(
    @Query('q') query: string,
    @Query('sessionToken') sessionToken: string,
    @Query('city') city?: string,
  ) {
    return this.maps.autocomplete(query, sessionToken, city);
  }

  /**
   * Geocode a city or address string to latitude/longitude.
   * Returns null when Google Maps API key is not configured.
   */
  @Get('geocode')
  @Public()
  @ThrottleStrict()
  @ApiOperation({ summary: 'Geocode an address to lat/lng' })
  @ApiQuery({ name: 'address', description: 'Address or city name' })
  async geocode(@Query('address') address: string) {
    return this.maps.geocode(address);
  }

  /**
   * Calculate road distance and ETA between two locations.
   * Falls back to Haversine estimate for major Saudi cities when API key not configured.
   */
  @Get('distance')
  @Public()
  @ThrottleStrict()
  @ApiOperation({ summary: 'Road distance and ETA between two addresses' })
  @ApiQuery({ name: 'origin', description: 'Origin address or city' })
  @ApiQuery({ name: 'destination', description: 'Destination address or city' })
  async distance(@Query('origin') origin: string, @Query('destination') destination: string) {
    return this.maps.getDistance(origin, destination);
  }
}
