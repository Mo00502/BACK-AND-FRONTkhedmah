import { MapsService } from './maps.service';

// Mock axios to avoid real HTTP calls
jest.mock('axios');
import axios from 'axios';
const mockedAxios = axios as jest.Mocked<typeof axios>;

const makeConfig = (apiKey: string | null) => ({
  get: jest.fn((key: string, fallback?: any) => {
    if (key === 'GOOGLE_MAPS_API_KEY') return apiKey ?? undefined;
    return fallback;
  }),
});

describe('MapsService', () => {
  describe('when GOOGLE_MAPS_API_KEY is not configured', () => {
    let service: MapsService;

    beforeEach(() => {
      jest.clearAllMocks();
      service = new MapsService(makeConfig(null) as any);
    });

    it('geocode() returns null', async () => {
      const result = await service.geocode('الرياض');
      expect(result).toBeNull();
      expect(mockedAxios.get).not.toHaveBeenCalled();
    });

    it('reverseGeocode() returns null', async () => {
      const result = await service.reverseGeocode(24.71, 46.67);
      expect(result).toBeNull();
    });

    it('autocomplete() returns empty array', async () => {
      const result = await service.autocomplete('الرياض', 'token-123');
      expect(result).toEqual([]);
    });

    it('getDistance() falls back to haversine estimate for known Saudi cities', async () => {
      const result = await service.getDistance('الرياض', 'جدة');
      expect(result).not.toBeNull();
      expect(result!.distanceMeters).toBeGreaterThan(0);
    });

    it('getDistance() returns null for unknown cities', async () => {
      const result = await service.getDistance('UnknownCity', 'AnotherCity');
      expect(result).toBeNull();
    });
  });

  describe('when GOOGLE_MAPS_API_KEY is configured', () => {
    let service: MapsService;

    beforeEach(() => {
      jest.clearAllMocks();
      service = new MapsService(makeConfig('test-api-key') as any);
    });

    it('geocode() returns parsed result on OK response', async () => {
      (mockedAxios.get as jest.Mock).mockResolvedValue({
        data: {
          status: 'OK',
          results: [
            {
              geometry: { location: { lat: 24.71, lng: 46.67 } },
              formatted_address: 'الرياض، السعودية',
              place_id: 'place-123',
            },
          ],
        },
      });

      const result = await service.geocode('الرياض');

      expect(result).toMatchObject({
        latLng: { lat: 24.71, lng: 46.67 },
        formattedAddress: 'الرياض، السعودية',
        placeId: 'place-123',
      });
    });

    it('geocode() returns null when API returns non-OK status', async () => {
      (mockedAxios.get as jest.Mock).mockResolvedValue({
        data: { status: 'ZERO_RESULTS', results: [] },
      });

      const result = await service.geocode('لاشيء');
      expect(result).toBeNull();
    });

    it('autocomplete() returns empty array for empty query', async () => {
      const result = await service.autocomplete('   ', 'token');
      expect(result).toEqual([]);
      expect(mockedAxios.get).not.toHaveBeenCalled();
    });

    it('autocomplete() maps API predictions to AutocompleteResult shape', async () => {
      (mockedAxios.get as jest.Mock).mockResolvedValue({
        data: {
          status: 'OK',
          predictions: [
            {
              place_id: 'p1',
              description: 'الرياض، السعودية',
              structured_formatting: { main_text: 'الرياض', secondary_text: 'السعودية' },
            },
          ],
        },
      });

      const result = await service.autocomplete('الرياض', 'tok');
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ placeId: 'p1', mainText: 'الرياض' });
    });
  });

  describe('distanceBetweenPoints()', () => {
    it('returns 0 for identical points', () => {
      const service = new MapsService(makeConfig(null) as any);
      const point = { lat: 24.71, lng: 46.67 };
      expect(service.distanceBetweenPoints(point, point)).toBe(0);
    });

    it('returns a positive distance for different points', () => {
      const service = new MapsService(makeConfig(null) as any);
      const riyadh = { lat: 24.71, lng: 46.67 };
      const jeddah = { lat: 21.49, lng: 39.19 };
      expect(service.distanceBetweenPoints(riyadh, jeddah)).toBeGreaterThan(800_000); // ~900km
    });
  });
});
