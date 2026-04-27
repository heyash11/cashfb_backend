import { Schema, model, Types, type HydratedDocument, type Model } from 'mongoose';
import { baseSchemaOptions } from './_base.js';
import { TIER_VALUES, type Tier } from './_tier.js';

export interface PostAdsConfig {
  topBannerKey?: string;
  bottomBannerKey?: string;
}

export interface PostAttrs {
  _id: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
  title: string;
  description?: string;
  dayKey: string; // 'YYYY-MM-DD' IST
  scheduledAt: Date;
  status: 'DRAFT' | 'SCHEDULED' | 'LIVE' | 'CLOSED';
  coinReward: number;
  /**
   * Phase 11.4 — renamed from `tierRequired`. Under the parallel-
   * tier product model this is a SCOPING field (which tab the post
   * appears on), not a HIERARCHICAL gate. List endpoints filter by
   * exact match; per-resource auth (getById, completePost) checks
   * the user's strict subscription set via `userCanAccessTier`.
   */
  tier: Tier;
  adsConfig?: PostAdsConfig;
  createdBy: Types.ObjectId;
  publishedAt?: Date;
  closedAt?: Date;
}

const PostSchema = new Schema(
  {
    title: { type: String, required: true, maxlength: 200 },
    description: String,
    dayKey: { type: String, required: true, index: true }, // 'YYYY-MM-DD' IST
    scheduledAt: { type: Date, required: true, index: true },
    status: {
      type: String,
      enum: ['DRAFT', 'SCHEDULED', 'LIVE', 'CLOSED'],
      default: 'DRAFT',
      index: true,
    },
    coinReward: { type: Number, default: 1 },
    tier: { type: String, enum: TIER_VALUES, default: 'PUBLIC', required: true },
    adsConfig: {
      topBannerKey: String,
      bottomBannerKey: String,
    },
    createdBy: { type: Types.ObjectId, ref: 'AdminUser', required: true },
    publishedAt: Date,
    closedAt: Date,
  },
  baseSchemaOptions,
);

PostSchema.index({ dayKey: 1, status: 1, scheduledAt: 1 }); // daily feed (legacy, retained)
// Phase 11.4 — tier-scoped daily feed. Prefix on `tier` keeps the
// per-tab list endpoint equality-bounded; secondary keys cover the
// status filter + scheduledAt sort.
PostSchema.index({ tier: 1, dayKey: 1, status: 1, scheduledAt: 1 });

export type PostDoc = HydratedDocument<PostAttrs>;
export const PostModel: Model<PostAttrs> = model<PostAttrs>('Post', PostSchema, 'posts');
export { PostSchema };
