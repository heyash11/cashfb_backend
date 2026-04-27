import { Schema, model, Types, type HydratedDocument, type Model } from 'mongoose';
import { baseSchemaOptions } from './_base.js';
import { TIER_VALUES, type Tier } from './_tier.js';

export interface RedeemCodeAttrs {
  _id: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
  batchId: Types.ObjectId;
  denomination: number;
  /**
   * Phase 11.0 — denormalized tier for FCFS scan perf. At publish
   * time the value is sourced from `Post.tierRequired`; pre-migration
   * rows backfill to `'PUBLIC'` (or to parent Post's tierRequired if
   * postId is set). The denormalization avoids an aggregation
   * `$lookup` on every tier-scoped scan once Phase 11.4 lands the
   * parallel-scoping list endpoints.
   */
  tier: Tier;
  // Encrypted at rest (envelope helper).
  codeCt: string;
  codeIv?: string;
  codeTag?: string;
  codeDekEnc?: string;
  codeHash: string; // HMAC-SHA256 for dedupe
  status: 'AVAILABLE' | 'PUBLISHED' | 'COPIED' | 'CLAIMED' | 'EXPIRED' | 'VOID';
  postId?: Types.ObjectId;
  publishedAt?: Date;
  firstCopiedBy?: Types.ObjectId;
  firstCopiedAt?: Date;
  copyCount: number;
  claimedBy?: Types.ObjectId;
  claimedAt?: Date;
  voidedReason?: string;
}

const RedeemCodeSchema = new Schema(
  {
    batchId: { type: Types.ObjectId, ref: 'RedeemCodeBatch', required: true, index: true },
    denomination: { type: Number, required: true },
    // Phase 11.0 — denormalized from Post.tierRequired at publish time.
    tier: { type: String, enum: TIER_VALUES, default: 'PUBLIC', required: true },
    // Encrypted at rest (envelope helper).
    codeCt: { type: String, required: true },
    codeIv: String,
    codeTag: String,
    codeDekEnc: String,
    codeHash: { type: String, required: true, unique: true }, // HMAC-SHA256 for dedupe
    status: {
      type: String,
      enum: ['AVAILABLE', 'PUBLISHED', 'COPIED', 'CLAIMED', 'EXPIRED', 'VOID'],
      default: 'AVAILABLE',
      required: true,
      index: true,
    },
    postId: { type: Types.ObjectId, ref: 'Post', index: true },
    publishedAt: Date,
    firstCopiedBy: { type: Types.ObjectId, ref: 'User' },
    firstCopiedAt: Date,
    copyCount: { type: Number, default: 0 },
    claimedBy: { type: Types.ObjectId, ref: 'User', index: true },
    claimedAt: Date,
    voidedReason: String,
  },
  baseSchemaOptions,
);

RedeemCodeSchema.index({ status: 1, batchId: 1 }); // admin batch view
RedeemCodeSchema.index({ postId: 1, status: 1 }); // per-post FCFS scan
// Phase 11.0 — tier-scoped FCFS scan. Phase 11.4 list endpoints
// filter `redeem_codes` by the requesting user's accessible tier
// section; the leading `tier` key keeps that scan equality-bounded
// and the trailing `postId` makes per-post tier-scoped queries
// covered.
RedeemCodeSchema.index({ tier: 1, status: 1, postId: 1 });

export type RedeemCodeDoc = HydratedDocument<RedeemCodeAttrs>;
export const RedeemCodeModel: Model<RedeemCodeAttrs> = model<RedeemCodeAttrs>(
  'RedeemCode',
  RedeemCodeSchema,
  'redeem_codes',
);
export { RedeemCodeSchema };
