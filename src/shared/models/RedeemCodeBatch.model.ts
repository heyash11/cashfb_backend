import {
  Schema,
  model,
  Types,
  type HydratedDocument,
  type InferSchemaType,
  type Model,
} from 'mongoose';
import { baseSchemaOptions } from './_base.js';

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

export type RedeemCodeBatchAttrs = InferSchemaType<typeof RedeemCodeBatchSchema>;
export type RedeemCodeBatchDoc = HydratedDocument<RedeemCodeBatchAttrs>;
export const RedeemCodeBatchModel: Model<RedeemCodeBatchAttrs> = model<RedeemCodeBatchAttrs>(
  'RedeemCodeBatch',
  RedeemCodeBatchSchema,
  'redeem_code_batches',
);
export { RedeemCodeBatchSchema };
