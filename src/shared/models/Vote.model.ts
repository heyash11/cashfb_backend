import {
  Schema,
  model,
  Types,
  type HydratedDocument,
  type InferSchemaType,
  type Model,
} from 'mongoose';
import { baseSchemaOptions } from './_base.js';

const VoteSchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: 'User', required: true },
    dayKey: { type: String, required: true },
    target: { type: String, required: true },
    // Schema default is a belt-and-braces fallback per ambiguity #7.
    // app_config.coinsPerVote is the canonical runtime source.
    coinsSpent: { type: Number, default: 3 },
    ipAddress: String,
    device: String,
  },
  baseSchemaOptions,
);

VoteSchema.index({ userId: 1, dayKey: 1 }, { unique: true }); // once-per-day HARD rule
VoteSchema.index({ dayKey: 1, target: 1 }); // target tally per day
VoteSchema.index({ dayKey: 1, createdAt: 1 }); // chronological per day

export type VoteAttrs = InferSchemaType<typeof VoteSchema>;
export type VoteDoc = HydratedDocument<VoteAttrs>;
export const VoteModel: Model<VoteAttrs> = model<VoteAttrs>('Vote', VoteSchema, 'votes');
export { VoteSchema };
