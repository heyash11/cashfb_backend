import { z } from 'zod';
import { TIER_VALUES } from '../../shared/models/_tier.js';

/**
 * Query + param schemas for user-facing post endpoints.
 *
 * Phase 11.4 — `tier` is REQUIRED on the list query. Each tier tab
 * is a separate fetch; missing tier → 400 ValidationError.
 */

const ObjectIdSchema = z.string().regex(/^[0-9a-f]{24}$/i, 'invalid ObjectId');
const DayKeySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD');

export const PostIdParamsSchema = z
  .object({
    id: ObjectIdSchema,
  })
  .strict();

export const ListPostsQuerySchema = z
  .object({
    date: DayKeySchema,
    tier: z.enum(TIER_VALUES),
  })
  .strict();

export type PostIdParams = z.infer<typeof PostIdParamsSchema>;
export type ListPostsQuery = z.infer<typeof ListPostsQuerySchema>;
