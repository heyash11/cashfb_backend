import { Schema, model, Types, type HydratedDocument, type Model } from 'mongoose';
import { baseSchemaOptions } from './_base.js';

export interface RedeemCodeBatchAttrs {
  _id: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
  uploadedBy: Types.ObjectId;
  supplierName: string; // Xoxoday / Plum / Zaggle / Qwikcilver / Pine Labs
  supplierInvoiceNumber?: string;
  supplierInvoiceUrl?: string; // S3 key
  denomination: number; // paise (₹50 = 5000)
  count: number;
  totalValue?: number;
  notes?: string;
  status: 'STAGED' | 'LIVE' | 'EXHAUSTED';
}

const RedeemCodeBatchSchema = new Schema(
  {
    uploadedBy: { type: Types.ObjectId, ref: 'AdminUser', required: true },
    supplierName: { type: String, required: true }, // Xoxoday / Plum / Zaggle / Qwikcilver / Pine Labs
    supplierInvoiceNumber: String,
    supplierInvoiceUrl: String, // S3 key
    denomination: { type: Number, required: true, default: 5000 }, // paise (₹50)
    count: { type: Number, required: true },
    totalValue: Number,
    notes: String,
    status: {
      type: String,
      enum: ['STAGED', 'LIVE', 'EXHAUSTED'],
      default: 'STAGED',
      index: true,
    },
  },
  baseSchemaOptions,
);

export type RedeemCodeBatchDoc = HydratedDocument<RedeemCodeBatchAttrs>;
export const RedeemCodeBatchModel: Model<RedeemCodeBatchAttrs> = model<RedeemCodeBatchAttrs>(
  'RedeemCodeBatch',
  RedeemCodeBatchSchema,
  'redeem_code_batches',
);
export { RedeemCodeBatchSchema };
