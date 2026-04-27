import { Schema, model, type HydratedDocument, type Model, type Types } from 'mongoose';
import { baseSchemaOptions } from './_base.js';
import { TIER_VALUES, type Tier } from './_tier.js';

export interface PrizePoolAttrs {
  _id: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
  /**
   * Tier section this pool belongs to (Phase 11.0 parallel-tier
   * model). Phase 11.2 will fan the daily cron out to one row per
   * tier per day; pre-migration rows backfill to `'PUBLIC'`.
   */
  tier: Tier;
  dayKey: string;
  yesterdayVoteCount: number;
  baseRate: number; // paise per vote
  totalPool: number; // paise
  giftCodeBudget?: number; // 70%
  customRoomBudget?: number; // 30%
  proMultiplier: number;
  proMaxMultiplier: number;
  status: 'CALCULATED' | 'PUBLISHED' | 'CLOSED';
  calculatedAt?: Date;
  publishedAt?: Date;
  closedAt?: Date;
}

const PrizePoolSchema = new Schema(
  {
    // Phase 11.0 — `tier` joins `dayKey` as the row's identity. The
    // pre-11.0 unique-on-dayKey index is dropped via syncIndexes() at
    // boot when MONGO_SYNC_INDEXES_ON_BOOT=true.
    tier: { type: String, enum: TIER_VALUES, default: 'PUBLIC', required: true },
    dayKey: { type: String, required: true },
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

// Phase 11.0 — one pool row per (tier, dayKey). Replaces the prior
// unique-on-dayKey index.
PrizePoolSchema.index({ tier: 1, dayKey: 1 }, { unique: true });

export type PrizePoolDoc = HydratedDocument<PrizePoolAttrs>;
export const PrizePoolModel: Model<PrizePoolAttrs> = model<PrizePoolAttrs>(
  'PrizePool',
  PrizePoolSchema,
  'prize_pools',
);
export { PrizePoolSchema };
