import {
  Schema,
  model,
  Types,
  type HydratedDocument,
  type InferSchemaType,
  type Model,
} from 'mongoose';
import { baseSchemaOptions } from './_base.js';

const PrizePoolWinnerSchema = new Schema(
  {
    dayKey: { type: String, required: true, index: true },
    userId: { type: Types.ObjectId, ref: 'User', required: true, index: true },
    type: { type: String, enum: ['GIFT_CODE', 'CUSTOM_ROOM'], required: true },
    tier: { type: String, enum: ['PUBLIC', 'PRO', 'PRO_MAX'] },
    baseAmount: Number,
    multiplier: { type: Number, default: 1 },
    finalAmount: Number,
    redeemCodeId: { type: Types.ObjectId, ref: 'RedeemCode' },
    customRoomId: { type: Types.ObjectId, ref: 'CustomRoom' },
    tdsDeducted: { type: Number, default: 0 }, // paise, 30% under 194BA
    tdsChallanNo: String,
    form16aIssuedAt: Date,
    panAtPayout: String, // last-4 masked
    payoutStatus: {
      type: String,
      enum: ['PENDING', 'RELEASED', 'WITHHELD', 'VOID'],
      default: 'PENDING',
    },
    releasedAt: Date,
  },
  baseSchemaOptions,
);

PrizePoolWinnerSchema.index({ dayKey: 1, userId: 1 }); // per-day/per-user lookup
PrizePoolWinnerSchema.index({ userId: 1, type: 1 }); // user payout history

// Prevent duplicate award of the same gift code or same custom-room entry
// to the same user on the same day. Partial filters scope each unique
// index to its own prize type (ambiguity #8 resolution).
PrizePoolWinnerSchema.index(
  { userId: 1, dayKey: 1, type: 1, redeemCodeId: 1 },
  { unique: true, partialFilterExpression: { type: 'GIFT_CODE' } },
);
PrizePoolWinnerSchema.index(
  { userId: 1, dayKey: 1, type: 1, customRoomId: 1 },
  { unique: true, partialFilterExpression: { type: 'CUSTOM_ROOM' } },
);

export type PrizePoolWinnerAttrs = InferSchemaType<typeof PrizePoolWinnerSchema>;
export type PrizePoolWinnerDoc = HydratedDocument<PrizePoolWinnerAttrs>;
export const PrizePoolWinnerModel: Model<PrizePoolWinnerAttrs> = model<PrizePoolWinnerAttrs>(
  'PrizePoolWinner',
  PrizePoolWinnerSchema,
  'prize_pool_winners',
);
export { PrizePoolWinnerSchema };
