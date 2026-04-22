import { z } from 'zod';

/**
 * Query + param schemas for user-facing post endpoints. Bodies are
 * not validated this chunk because the only user POST (`complete`)
 * carries no body. Controllers invoke `.parse(req.query | req.params)`
 * directly; ZodErrors map to `ValidationError` via the global error
 * handler.
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
  })
  .strict();

export type PostIdParams = z.infer<typeof PostIdParamsSchema>;
export type ListPostsQuery = z.infer<typeof ListPostsQuerySchema>;
