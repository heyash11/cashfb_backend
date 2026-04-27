import { Schema, model, Types, type HydratedDocument, type Model } from 'mongoose';
import { baseSchemaOptions } from './_base.js';
import { TIER_VALUES, type Tier } from './_tier.js';

export interface VoteAttrs {
  _id: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
  userId: Types.ObjectId;
  dayKey: string;
  /**
   * Tier section the vote was cast in (Phase 11.0 parallel-tier model).
   * Schema default `'PUBLIC'` covers backfill of pre-migration rows;
   * Phase 11.1 makes the writer pass it explicitly.
   */
  tier: Tier;
  target: string;
  /** Schema default 3; app_config.coinsPerVote is canonical at runtime (ambiguity #7). */
  coinsSpent: number;
  ipAddress?: string;
  device?: string;
}

const VoteSchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: 'User', required: true },
    dayKey: { type: String, required: true },
    // Phase 11.0 — parallel tier-scoped voting. `default: 'PUBLIC'`
    // backfills pre-migration rows transparently; Phase 11.1 wires
    // VoteService.castVote to pass the caller's tier explicitly.
    tier: { type: String, enum: TIER_VALUES, default: 'PUBLIC', required: true },
    target: { type: String, required: true },
    // Schema default is a belt-and-braces fallback per ambiguity #7.
    // app_config.coinsPerVote is the canonical runtime source.
    coinsSpent: { type: Number, default: 3 },
    ipAddress: String,
    device: String,
  },
  baseSchemaOptions,
);

// Phase 11.0 — once-per-tier-per-day HARD rule (replaces the prior
// once-per-day rule). Mongoose syncIndexes() drops the legacy
// {userId,dayKey} unique on first boot of this release when
// MONGO_SYNC_INDEXES_ON_BOOT=true.
VoteSchema.index({ userId: 1, tier: 1, dayKey: 1 }, { unique: true });
VoteSchema.index({ dayKey: 1, tier: 1, target: 1 }); // tier-scoped target tally per day
VoteSchema.index({ dayKey: 1, createdAt: 1 }); // chronological per day

export type VoteDoc = HydratedDocument<VoteAttrs>;
export const VoteModel: Model<VoteAttrs> = model<VoteAttrs>('Vote', VoteSchema, 'votes');
export { VoteSchema };
