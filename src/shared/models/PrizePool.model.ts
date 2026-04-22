import { Schema, model, type HydratedDocument, type Model, type Types } from 'mongoose';
import { baseSchemaOptions } from './_base.js';

export interface PrizePoolAttrs {
  _id: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
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

export type PrizePoolDoc = HydratedDocument<PrizePoolAttrs>;
export const PrizePoolModel: Model<PrizePoolAttrs> = model<PrizePoolAttrs>(
  'PrizePool',
  PrizePoolSchema,
  'prize_pools',
);
export { PrizePoolSchema };
