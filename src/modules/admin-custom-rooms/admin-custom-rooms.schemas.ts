import { z } from 'zod';

const ObjectIdHex = z.string().regex(/^[a-f0-9]{24}$/i, '24-char hex ObjectId');

const DayKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'dayKey must be YYYY-MM-DD');
const GameSchema = z.enum(['BGMI', 'FF']);
const TierSchema = z.enum(['PUBLIC', 'PRO', 'PRO_MAX']);

export const AdminRoomCreateBodySchema = z
  .object({
    game: GameSchema,
    dayKey: DayKey,
    scheduledAt: z.coerce.date(),
    visibleFromAt: z.coerce.date().optional(),
    resultEnabledAt: z.coerce.date().optional(),
    tier: TierSchema.optional(),
    pageNumber: z.number().int().min(1).optional(),
    notice: z.string().max(500).optional(),
  })
  .strict();

export const AdminRoomCredentialsBodySchema = z
  .object({
    roomId: z.string().min(1).max(64),
    roomPwd: z.string().min(1).max(64),
  })
  .strict();

const WinnerBucketSchema = z
  .object({
    imageUrl: z.string().max(500).optional(),
    squadName: z.string().max(100).optional(),
    winners: z
      .array(
        z
          .object({
            userId: ObjectIdHex,
            prize: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

export const AdminEnterResultsBodySchema = z
  .object({
    inRoomImageUrl: z.string().max(500).optional(),
    top1: WinnerBucketSchema.optional(),
    top2: WinnerBucketSchema.optional(),
    top3: WinnerBucketSchema.optional(),
    extra: WinnerBucketSchema.optional(),
  })
  .strict();

export const AdminAssignWinnersBodySchema = z
  .object({
    dayKey: DayKey,
    winners: z
      .array(
        z
          .object({
            userId: ObjectIdHex,
            type: z.enum(['GIFT_CODE', 'CUSTOM_ROOM']),
            baseAmount: z.number().int().nonnegative(),
            tier: TierSchema,
            redeemCodeId: ObjectIdHex.optional(),
            customRoomId: ObjectIdHex.optional(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export const AdminRoomsListQuerySchema = z
  .object({
    game: GameSchema.optional(),
    status: z.enum(['SCHEDULED', 'LIVE', 'COMPLETED', 'CANCELLED']).optional(),
    dayKey: DayKey.optional(),
    cursor: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

export type AdminRoomCreateBody = z.infer<typeof AdminRoomCreateBodySchema>;
export type AdminRoomCredentialsBody = z.infer<typeof AdminRoomCredentialsBodySchema>;
export type AdminEnterResultsBody = z.infer<typeof AdminEnterResultsBodySchema>;
export type AdminAssignWinnersBody = z.infer<typeof AdminAssignWinnersBodySchema>;
export type AdminRoomsListQuery = z.infer<typeof AdminRoomsListQuerySchema>;
