/**
 * Centralised cache key constants and TTL values (milliseconds).
 * Import these wherever caching is applied so key names stay consistent.
 */
export const CacheKeys = {
  // Service catalog — changes rarely
  SERVICES_CATEGORIES: 'services:categories',
  SERVICE_BY_ID: (id: string) => `service:${id}`,

  // Platform analytics overview — refresh every 5 minutes
  ANALYTICS_OVERVIEW: 'analytics:overview',

  // Equipment listings by region/category
  EQUIPMENT_LIST: (region: string, cat: string, page: number) =>
    `equipment:${region}:${cat}:${page}`,
  EQUIPMENT_DETAIL: (id: string) => `equipment:${id}`,

  // Top providers by service
  PROVIDERS_BY_SERVICE: (serviceId: string, page: number) =>
    `providers:service:${serviceId}:${page}`,

  // Search autocomplete (short TTL)
  AUTOCOMPLETE: (q: string) => `autocomplete:${q}`,
} as const;

export const CacheTTL = {
  SHORT: 60_000, //  1 minute
  MEDIUM: 5 * 60_000, //  5 minutes
  LONG: 60 * 60_000, //  1 hour
  VERY_LONG: 24 * 60 * 60_000, // 24 hours
} as const;
