import { z } from 'zod';
import { TIER_VALUES } from '../../shared/models/_tier.js';

/**
 * Query string for `GET /api/v1/prize-pools/today`. Phase 11.6 —
 * public-facing read. `tier` is REQUIRED so the client commits to a
 * specific tier section per request; missing tier → 400.
 */
export const TodayPoolQuerySchema = z
  .object({
    tier: z.enum(TIER_VALUES),
  })
  .strict();

export type TodayPoolQuery = z.infer<typeof TodayPoolQuerySchema>;
