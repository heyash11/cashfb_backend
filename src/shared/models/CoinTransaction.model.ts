import {
  Schema,
  model,
  Types,
  type HydratedDocument,
  type InferSchemaType,
  type Model,
} from 'mongoose';
import { baseSchemaOptions } from './_base.js';

const CoinTransactionSchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: 'User', required: true, index: true },
    type: {
      type: String,
      enum: ['SIGNUP_BONUS', 'POST_REWARD', 'VOTE_SPEND', 'ADMIN_CREDIT', 'ADMIN_DEBIT', 'REFUND'],
      required: true,
      index: true,
    },
    amount: { type: Number, required: true }, // +ve credit, -ve debit
    balanceAfter: { type: Number, required: true },
    reference: {
      kind: { type: String, enum: ['Post', 'Vote', 'Admin', 'System'] },
      id: { type: Types.ObjectId },
    },
    note: String,
  },
  baseSchemaOptions,
);

CoinTransactionSchema.index({ userId: 1, createdAt: -1 }); // paginated coin history

export type CoinTransactionAttrs = InferSchemaType<typeof CoinTransactionSchema>;
export type CoinTransactionDoc = HydratedDocument<CoinTransactionAttrs>;
export const CoinTransactionModel: Model<CoinTransactionAttrs> = model<CoinTransactionAttrs>(
  'CoinTransaction',
  CoinTransactionSchema,
  'coin_transactions',
);
export { CoinTransactionSchema };
