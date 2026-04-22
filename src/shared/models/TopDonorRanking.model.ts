import { Schema, model, Types, type HydratedDocument, type Model } from 'mongoose';
import { baseSchemaOptionsNoTimestamps } from './_base.js';
import type { SocialLinks } from './_shared.js';

/**
 * Materialised view of donors by cumulative total. Refreshed every
 * 5 min by the top-donor-cache cron. `computedAt` is the domain
 * timestamp; no createdAt/updatedAt.
 */
export interface TopDonorRankingAttrs {
  _id: Types.ObjectId;
  rank: number; // 1 = top donor
  userId?: Types.ObjectId;
  displayName?: string;
  avatarUrl?: string;
  socialLinks?: SocialLinks;
  totalDonated: number; // paise
  donationCount?: number;
  computedAt: Date;
}

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

export type TopDonorRankingDoc = HydratedDocument<TopDonorRankingAttrs>;
export const TopDonorRankingModel: Model<TopDonorRankingAttrs> = model<TopDonorRankingAttrs>(
  'TopDonorRanking',
  TopDonorRankingSchema,
  'top_donor_rankings',
);
export { TopDonorRankingSchema };
