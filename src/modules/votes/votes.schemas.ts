import { z } from 'zod';
import { TIER_VALUES } from '../../shared/models/_tier.js';

/**
 * `target` is intentionally an opaque string — product decision
 * deferred per Phase 3 ambiguity #6 (now §PD9 in PRODUCT_MODEL.md:
 * Flutter enforces target = Post._id | CustomRoom._id; backend
 * doesn't validate the FK).
 *
 * `tier` was added in Phase 11.1 — required field. The Vote schema
 * still accepts a default of 'PUBLIC', but the API contract demands
 * an explicit choice from the client so the parallel-tier sections
 * are unambiguous.
 */
export const CastVoteBodySchema = z
  .object({
    target: z.string().trim().min(1).max(100),
    tier: z.enum(TIER_VALUES),
  })
  .strict();

export type CastVoteBody = z.infer<typeof CastVoteBodySchema>;

/**
 * Query string for `GET /votes/today`. `tier` is OPTIONAL on the
 * wire (defaults to 'PUBLIC' for pre-11.1 client backwards compat),
 * but the response always echoes the resolved tier so the client
 * can render the correct slot's eligibility unambiguously.
 */
export const TodayQuerySchema = z
  .object({
    tier: z.enum(TIER_VALUES).optional(),
  })
  .strict();

export type TodayQuery = z.infer<typeof TodayQuerySchema>;
