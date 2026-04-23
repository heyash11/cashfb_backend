import { Schema, model, Types, type HydratedDocument, type Model } from 'mongoose';
import { baseSchemaOptions } from './_base.js';

export interface CoinTransactionReference {
  kind?: 'Post' | 'Vote' | 'Admin' | 'System';
  id?: Types.ObjectId;
}

export interface CoinTransactionAttrs {
  _id: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
  userId: Types.ObjectId;
  type: 'SIGNUP_BONUS' | 'POST_REWARD' | 'VOTE_SPEND' | 'ADMIN_CREDIT' | 'ADMIN_DEBIT' | 'REFUND';
  amount: number; // +ve credit, -ve debit
  balanceAfter: number;
  reference?: CoinTransactionReference;
  note?: string;
  /**
   * Required for ADMIN_CREDIT / ADMIN_DEBIT entries — the operator's
   * justification, enforced at the admin-users Zod layer (min 10
   * chars). Optional for other `type` values that are system-
   * generated (SIGNUP_BONUS, POST_REWARD, VOTE_SPEND, REFUND).
   */
  reason?: string;
}

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
    reason: String,
  },
  baseSchemaOptions,
);

CoinTransactionSchema.index({ userId: 1, createdAt: -1 }); // paginated coin history

export type CoinTransactionDoc = HydratedDocument<CoinTransactionAttrs>;
export const CoinTransactionModel: Model<CoinTransactionAttrs> = model<CoinTransactionAttrs>(
  'CoinTransaction',
  CoinTransactionSchema,
  'coin_transactions',
);
export { CoinTransactionSchema };
