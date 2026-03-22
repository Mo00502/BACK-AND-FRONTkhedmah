import { Throttle, SkipThrottle } from '@nestjs/throttler';

/**
 * Pre-configured throttle profiles.
 * Usage:
 *   @ThrottleAuth()        // 5 attempts per minute (OTP, login)
 *   @ThrottleStrict()      // 10 per minute (payment, escrow release)
 *   @ThrottleRelaxed()     // 300 per minute (read-only public endpoints)
 *   @SkipThrottle()        // bypass (health checks, webhooks)
 */

/** 5 requests / 60 seconds — for OTP and authentication endpoints */
export const ThrottleAuth = () => Throttle({ default: { limit: 5, ttl: 60_000 } });

/** 10 requests / 60 seconds — for sensitive write operations */
export const ThrottleStrict = () => Throttle({ default: { limit: 10, ttl: 60_000 } });

/** 30 requests / 60 seconds — default for most authenticated actions */
export const ThrottleDefault = () => Throttle({ default: { limit: 30, ttl: 60_000 } });

/** 300 requests / 60 seconds — public search, catalog, listing reads */
export const ThrottleRelaxed = () => Throttle({ default: { limit: 300, ttl: 60_000 } });

/** Re-export for convenience */
export { SkipThrottle };
