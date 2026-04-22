import { Schema, model, Types, type HydratedDocument, type Model } from 'mongoose';
import { baseSchemaOptions } from './_base.js';

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
  tierRequired: 'PUBLIC' | 'PRO' | 'PRO_MAX';
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
    tierRequired: {
      type: String,
      enum: ['PUBLIC', 'PRO', 'PRO_MAX'],
      default: 'PUBLIC',
    },
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

PostSchema.index({ dayKey: 1, status: 1, scheduledAt: 1 }); // daily feed

export type PostDoc = HydratedDocument<PostAttrs>;
export const PostModel: Model<PostAttrs> = model<PostAttrs>('Post', PostSchema, 'posts');
export { PostSchema };
