import {
  Schema,
  model,
  Types,
  type HydratedDocument,
  type InferSchemaType,
  type Model,
} from 'mongoose';
import { baseSchemaOptionsNoTimestamps } from './_base.js';

/**
 * Materialised view of donors by cumulative total. Refreshed every
 * 5 min by the top-donor-cache cron. Do not compute on every home
 * feed request.
 */
const TopDonorRankingSchema = new Schema(
  {
    rank: { type: Number, required: true, index: true }, // 1 = top donor
    userId: { type: Types.ObjectId, ref: 'User', index: true },
    displayName: String,
    avatarUrl: String,
    socialLinks: { youtube: String, facebook: String, instagram: String },
    totalDonated: { type: Number, required: true }, // paise
    donationCount: Number,
    computedAt: { type: Date, default: Date.now, index: true },
  },
  baseSchemaOptionsNoTimestamps,
);

export type TopDonorRankingAttrs = InferSchemaType<typeof TopDonorRankingSchema>;
export type TopDonorRankingDoc = HydratedDocument<TopDonorRankingAttrs>;
export const TopDonorRankingModel: Model<TopDonorRankingAttrs> = model<TopDonorRankingAttrs>(
  'TopDonorRanking',
  TopDonorRankingSchema,
  'top_donor_rankings',
);
export { TopDonorRankingSchema };
