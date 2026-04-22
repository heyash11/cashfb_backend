import {
  Schema,
  model,
  Types,
  type HydratedDocument,
  type InferSchemaType,
  type Model,
} from 'mongoose';
import { baseSchemaOptionsNoTimestamps } from './_base.js';

const PostCompletionSchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: 'User', required: true },
    postId: { type: Types.ObjectId, ref: 'Post', required: true },
    dayKey: { type: String, required: true },
    completedAt: { type: Date, default: Date.now },
    coinAwarded: Number,
    coinTxId: { type: Types.ObjectId, ref: 'CoinTransaction' },
  },
  baseSchemaOptionsNoTimestamps,
);

PostCompletionSchema.index({ userId: 1, postId: 1 }, { unique: true }); // idempotent claim
PostCompletionSchema.index({ userId: 1, dayKey: 1 }); // today's completions for user
PostCompletionSchema.index({ postId: 1, completedAt: -1 }); // completions per post

export type PostCompletionAttrs = InferSchemaType<typeof PostCompletionSchema>;
export type PostCompletionDoc = HydratedDocument<PostCompletionAttrs>;
export const PostCompletionModel: Model<PostCompletionAttrs> = model<PostCompletionAttrs>(
  'PostCompletion',
  PostCompletionSchema,
  'post_completions',
);
export { PostCompletionSchema };
