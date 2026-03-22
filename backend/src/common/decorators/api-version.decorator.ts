import { Version } from '@nestjs/common';

/**
 * Convenience wrappers for NestJS URI versioning.
 *
 * Usage on a controller:
 *   @ApiV1()   →  served at /api/v1/...  (same as the default, explicit is clearer)
 *   @ApiV2()   →  served at /api/v2/...  (opt-in for next-gen controllers)
 *
 * NestJS resolves the most specific version match, so a v2 controller
 * coexists with the v1 controller for the same resource during migration.
 */
export const ApiV1 = () => Version('1');
export const ApiV2 = () => Version('2');
