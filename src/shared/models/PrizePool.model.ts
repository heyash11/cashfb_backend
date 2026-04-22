import { Schema, model, type HydratedDocument, type InferSchemaType, type Model } from 'mongoose';
import { baseSchemaOptions } from './_base.js';

const PrizePoolSchema = new Schema(
  {
    dayKey: { type: String, required: true, unique: true },
    yesterdayVoteCount: { type: Number, required: true },
    baseRate: { type: Number, required: true }, // paise per vote
    totalPool: { type: Number, required: true }, // paise
    giftCodeBudget: Number, // 70%
    customRoomBudget: Number, // 30%
    proMultiplier: { type: Number, default: 5 },
    proMaxMultiplier: { type: Number, default: 10 },
    status: {
      type: String,
      enum: ['CALCULATED', 'PUBLISHED', 'CLOSED'],
      default: 'CALCULATED',
      index: true,
    },
    calculatedAt: Date,
    publishedAt: Date,
    closedAt: Date,
  },
  baseSchemaOptions,
);

export type PrizePoolAttrs = InferSchemaType<typeof PrizePoolSchema>;
export type PrizePoolDoc = HydratedDocument<PrizePoolAttrs>;
export const PrizePoolModel: Model<PrizePoolAttrs> = model<PrizePoolAttrs>(
  'PrizePool',
  PrizePoolSchema,
  'prize_pools',
);
export { PrizePoolSchema };
