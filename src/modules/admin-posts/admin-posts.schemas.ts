import { z } from 'zod';

/** YYYY-MM-DD calendar key used by the daily feed index. */
const DayKeySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'dayKey must be YYYY-MM-DD');

const StatusSchema = z.enum(['DRAFT', 'SCHEDULED', 'LIVE', 'CLOSED']);
const TierSchema = z.enum(['PUBLIC', 'PRO', 'PRO_MAX']);

const AdsConfigSchema = z
  .object({
    topBannerKey: z.string().max(200).optional(),
    bottomBannerKey: z.string().max(200).optional(),
  })
  .strict();

export const AdminPostCreateBodySchema = z
  .object({
    title: z.string().min(1).max(200),
    description: z.string().max(2000).optional(),
    dayKey: DayKeySchema,
    scheduledAt: z.coerce.date(),
    status: StatusSchema.optional(),
    coinReward: z.number().int().min(0).max(100).optional(),
    tier: TierSchema.optional(),
    adsConfig: AdsConfigSchema.optional(),
  })
  .strict();

export const AdminPostUpdateBodySchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).optional(),
    dayKey: DayKeySchema.optional(),
    scheduledAt: z.coerce.date().optional(),
    status: StatusSchema.optional(),
    coinReward: z.number().int().min(0).max(100).optional(),
    tier: TierSchema.optional(),
    adsConfig: AdsConfigSchema.optional(),
    publishedAt: z.coerce.date().optional(),
    closedAt: z.coerce.date().optional(),
  })
  .strict();

export const AdminPostListQuerySchema = z
  .object({
    dayKey: DayKeySchema,
    status: StatusSchema.optional(),
  })
  .strict();

export type AdminPostCreateBody = z.infer<typeof AdminPostCreateBodySchema>;
export type AdminPostUpdateBody = z.infer<typeof AdminPostUpdateBodySchema>;
export type AdminPostListQuery = z.infer<typeof AdminPostListQuerySchema>;
