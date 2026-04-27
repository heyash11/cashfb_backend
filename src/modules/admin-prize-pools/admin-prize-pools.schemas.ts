import { z } from 'zod';
import { TIER_VALUES } from '../../shared/models/_tier.js';

const DayKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'dayKey must be YYYY-MM-DD');

export const AdminPrizePoolsListQuerySchema = z
  .object({
    status: z.enum(['CALCULATED', 'PUBLISHED', 'CLOSED']).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

/**
 * Phase 11.2 — `tier` is OPTIONAL. Omitted = fan out all three
 * tiers (operator-friendly default, matches the cron's behavior).
 * Specified = run just that one tier (useful when the accountant
 * needs to re-publish a single tier after a tier-specific data
 * correction).
 */
export const AdminPrizePoolRunBodySchema = z
  .object({
    dayKey: DayKey,
    yesterdayDayKey: DayKey,
    tier: z.enum(TIER_VALUES).optional(),
    reason: z.string().min(10).max(500),
  })
  .strict();

export const AdminPrizePoolWinnersQuerySchema = z
  .object({
    dayKey: DayKey,
    payoutStatus: z.enum(['PENDING', 'RELEASED', 'WITHHELD', 'VOID']).optional(),
  })
  .strict();

export const AdminMarkPayoutBodySchema = z
  .object({
    payoutStatus: z.enum(['RELEASED', 'WITHHELD', 'VOID']),
    challanNo: z.string().min(1).max(100).optional(),
    panLast4: z
      .string()
      .regex(/^\d{4}$/, 'panLast4 must be 4 digits')
      .optional(),
    reason: z.string().min(10).max(500),
  })
  .strict();

export type AdminPrizePoolsListQuery = z.infer<typeof AdminPrizePoolsListQuerySchema>;
export type AdminPrizePoolRunBody = z.infer<typeof AdminPrizePoolRunBodySchema>;
export type AdminPrizePoolWinnersQuery = z.infer<typeof AdminPrizePoolWinnersQuerySchema>;
export type AdminMarkPayoutBody = z.infer<typeof AdminMarkPayoutBodySchema>;
