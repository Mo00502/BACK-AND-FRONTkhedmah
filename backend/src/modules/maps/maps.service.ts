import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

const GOOGLE_GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';
const GOOGLE_DISTANCE_URL = 'https://maps.googleapis.com/maps/api/distancematrix/json';
const GOOGLE_PLACES_URL = 'https://maps.googleapis.com/maps/api/place/autocomplete/json';

export interface LatLng {
  lat: number;
  lng: number;
}

export interface GeocodeResult {
  latLng: LatLng;
  formattedAddress: string;
  placeId: string;
}

export interface DistanceResult {
  distanceMeters: number;
  durationSeconds: number;
  distanceText: string;
  durationText: string;
}

export interface AutocompleteResult {
  placeId: string;
  description: string;
  mainText: string;
  secondaryText: string;
}

@Injectable()
export class MapsService {
  private readonly logger = new Logger(MapsService.name);
  private readonly apiKey: string | null;

  constructor(private config: ConfigService) {
    this.apiKey = config.get<string>('GOOGLE_MAPS_API_KEY') || null;

    if (!this.apiKey) {
      this.logger.warn(
        'GOOGLE_MAPS_API_KEY not set — Maps service running in degraded mode ' +
          '(geocoding and distance calculations will return null)',
      );
    }
  }

  // ── Geocoding ─────────────────────────────────────────────────────────────

  /**
   * Convert a human-readable address/city to latitude + longitude.
   * Returns null if API key not configured or geocoding fails.
   */
  async geocode(address: string): Promise<GeocodeResult | null> {
    if (!this.apiKey) return null;
    try {
      const { data } = await axios.get(GOOGLE_GEOCODE_URL, {
        params: { address, key: this.apiKey, language: 'ar', region: 'SA' },
        timeout: 5000,
      });

      if (data.status !== 'OK' || !data.results?.length) return null;

      const result = data.results[0];
      return {
        latLng: result.geometry.location,
        formattedAddress: result.formatted_address,
        placeId: result.place_id,
      };
    } catch (err: any) {
      this.logger.error('Geocode failed', err instanceof Error ? err.stack : String(err));
      return null;
    }
  }

  /**
   * Convert lat/lng back to a human-readable address (reverse geocoding).
   */
  async reverseGeocode(lat: number, lng: number): Promise<GeocodeResult | null> {
    if (!this.apiKey) return null;
    try {
      const { data } = await axios.get(GOOGLE_GEOCODE_URL, {
        params: { latlng: `${lat},${lng}`, key: this.apiKey, language: 'ar', region: 'SA' },
        timeout: 5000,
      });

      if (data.status !== 'OK' || !data.results?.length) return null;

      const result = data.results[0];
      return {
        latLng: { lat, lng },
        formattedAddress: result.formatted_address,
        placeId: result.place_id,
      };
    } catch (err: any) {
      this.logger.error('Reverse geocode failed', err instanceof Error ? err.stack : String(err));
      return null;
    }
  }

  // ── Distance Matrix ───────────────────────────────────────────────────────

  /**
   * Calculate road distance and ETA between two addresses.
   * Falls back to straight-line Haversine estimate when API key not configured.
   */
  async getDistance(origin: string, destination: string): Promise<DistanceResult | null> {
    if (!this.apiKey) {
      return this.haversineEstimate(origin, destination);
    }

    try {
      const { data } = await axios.get(GOOGLE_DISTANCE_URL, {
        params: {
          origins: origin,
          destinations: destination,
          key: this.apiKey,
          language: 'ar',
          region: 'SA',
          units: 'metric',
        },
        timeout: 5000,
      });

      if (data.status !== 'OK') return null;

      const element = data.rows?.[0]?.elements?.[0];
      if (!element || element.status !== 'OK') return null;

      return {
        distanceMeters: element.distance.value,
        durationSeconds: element.duration.value,
        distanceText: element.distance.text,
        durationText: element.duration.text,
      };
    } catch (err: any) {
      this.logger.error('Distance Matrix failed', err instanceof Error ? err.stack : String(err));
      return null;
    }
  }

  /**
   * Calculate distance between lat/lng pairs using the Haversine formula.
   * Used as a fallback when the Google Maps API key is not configured.
   */
  distanceBetweenPoints(a: LatLng, b: LatLng): number {
    const R = 6371e3; // Earth radius in metres
    const φ1 = (a.lat * Math.PI) / 180;
    const φ2 = (b.lat * Math.PI) / 180;
    const Δφ = ((b.lat - a.lat) * Math.PI) / 180;
    const Δλ = ((b.lng - a.lng) * Math.PI) / 180;
    const x = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
  }

  // ── Places Autocomplete ───────────────────────────────────────────────────

  /**
   * Address autocomplete for search inputs.
   * Restricted to Saudi Arabia and biased toward major cities.
   * Returns an empty array when API key not configured.
   */
  async autocomplete(
    query: string,
    sessionToken: string,
    cityBias?: string,
  ): Promise<AutocompleteResult[]> {
    if (!this.apiKey || !query?.trim()) return [];

    try {
      const { data } = await axios.get(GOOGLE_PLACES_URL, {
        params: {
          input: query,
          key: this.apiKey,
          language: 'ar',
          components: 'country:sa',
          sessiontoken: sessionToken,
          ...(cityBias ? { location: cityBias, radius: 50_000 } : {}),
        },
        timeout: 5000,
      });

      if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
        this.logger.warn(`Places Autocomplete status: ${data.status}`);
        return [];
      }

      return (data.predictions || []).map((p: any) => ({
        placeId: p.place_id,
        description: p.description,
        mainText: p.structured_formatting?.main_text ?? p.description,
        secondaryText: p.structured_formatting?.secondary_text ?? '',
      }));
    } catch (err: any) {
      this.logger.error('Autocomplete failed', err instanceof Error ? err.stack : String(err));
      return [];
    }
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  /**
   * Approximate city-to-city distances in Saudi Arabia (straight-line, km).
   * Used as a degraded fallback when the Maps API is not configured.
   */
  private haversineEstimate(origin: string, destination: string): DistanceResult | null {
    // Approximate city centre coordinates for Saudi Arabia
    const CITY_COORDS: Record<string, LatLng> = {
      الرياض: { lat: 24.7136, lng: 46.6753 },
      جدة: { lat: 21.4858, lng: 39.1925 },
      مكة: { lat: 21.3891, lng: 39.8579 },
      المدينة: { lat: 24.5247, lng: 39.5692 },
      الدمام: { lat: 26.3927, lng: 49.9777 },
      الخبر: { lat: 26.2794, lng: 50.2083 },
      الظهران: { lat: 26.2994, lng: 50.1514 },
      الطائف: { lat: 21.2854, lng: 40.4143 },
      أبها: { lat: 18.2164, lng: 42.5053 },
      تبوك: { lat: 28.3838, lng: 36.555 },
    };

    const normalise = (s: string) => s.trim().split(',')[0].trim();
    const src = CITY_COORDS[normalise(origin)];
    const dest = CITY_COORDS[normalise(destination)];

    if (!src || !dest) return null;

    const metres = this.distanceBetweenPoints(src, dest);
    const km = Math.round(metres / 1000);
    // Rough road-distance multiplier (1.3× straight-line) + average 80 km/h
    const roadKm = km * 1.3;
    const seconds = Math.round((roadKm / 80) * 3600);

    return {
      distanceMeters: Math.round(roadKm * 1000),
      durationSeconds: seconds,
      distanceText: `${roadKm.toFixed(0)} كم`,
      durationText: `${Math.round(seconds / 60)} دقيقة`,
    };
  }
}
