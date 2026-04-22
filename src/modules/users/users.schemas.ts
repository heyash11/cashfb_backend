import { z } from 'zod';

/**
 * Query schema for `GET /me/coins`. Cursor is validated as an opaque
 * string here — its internal shape (base64-encoded `{t, i}`) is a
 * service concern and surfaces as `INVALID_CURSOR` if malformed.
 * `limit` is hard-capped at 100 per the Phase 3 plan; >100 rejects
 * as VALIDATION_FAILED at this boundary.
 */
export const ListCoinsQuerySchema = z
  .object({
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export type ListCoinsQuery = z.infer<typeof ListCoinsQuerySchema>;
