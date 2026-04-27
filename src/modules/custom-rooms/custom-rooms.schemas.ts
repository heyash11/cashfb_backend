import { Types } from 'mongoose';
import { z } from 'zod';
import { TIER_VALUES } from '../../shared/models/_tier.js';

const ObjectIdHex = z
  .string()
  .regex(/^[0-9a-f]{24}$/i, 'Expected 24-char hex ObjectId')
  .transform((s) => new Types.ObjectId(s));

/**
 * Phase 11.4 — `tier` is REQUIRED. Each tier tab is a separate
 * fetch; missing tier → 400 ValidationError.
 *
 * `game` enum values:
 *   - `BGMI` — Battlegrounds Mobile India
 *   - `FF`   — Free Fire (abbreviated; canonical wire form)
 *
 * `dayKey` is the canonical query-string parameter name (NOT
 * `date`) — same `YYYY-MM-DD` IST format used everywhere else in
 * the codebase (votes, prize_pools).
 */
export const ListRoomsQuerySchema = z
  .object({
    game: z.enum(['BGMI', 'FF']),
    tier: z.enum(TIER_VALUES),
    page: z.coerce.number().int().min(1).max(50).default(1),
    dayKey: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
  })
  .strict();
export type ListRoomsQuery = z.infer<typeof ListRoomsQuerySchema>;

export const RoomIdParamsSchema = z.object({ id: ObjectIdHex }).strict();
export type RoomIdParams = z.infer<typeof RoomIdParamsSchema>;
