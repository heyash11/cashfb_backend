import { Schema, model, Types, type HydratedDocument, type Model } from 'mongoose';
import { baseSchemaOptions } from './_base.js';

export interface RedeemCodeAttrs {
  _id: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
  batchId: Types.ObjectId;
  denomination: number;
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

export type RedeemCodeDoc = HydratedDocument<RedeemCodeAttrs>;
export const RedeemCodeModel: Model<RedeemCodeAttrs> = model<RedeemCodeAttrs>(
  'RedeemCode',
  RedeemCodeSchema,
  'redeem_codes',
);
export { RedeemCodeSchema };
