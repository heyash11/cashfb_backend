import {
  Schema,
  model,
  Types,
  type HydratedDocument,
  type InferSchemaType,
  type Model,
} from 'mongoose';
import { baseSchemaOptions } from './_base.js';

const SubscriptionPaymentSchema = new Schema(
  {
    subscriptionId: {
      type: Types.ObjectId,
      ref: 'Subscription',
      required: true,
      index: true,
    },
    userId: { type: Types.ObjectId, ref: 'User', required: true, index: true },
    razorpayPaymentId: { type: String, required: true, unique: true },
    razorpayOrderId: { type: String, index: true },
    razorpayInvoiceId: String,
    amount: Number, // paise, total incl. GST
    baseAmount: Number,
    gstAmount: Number,
    cgst: Number,
    sgst: Number,
    igst: Number,
    placeOfSupply: String, // ISO 3166-2:IN state code
    sacCode: { type: String, default: '998439' },
    merchantGstin: String,
    customerGstin: String,
    invoiceNumber: { type: String, unique: true, sparse: true },
    invoicePdfUrl: String, // S3 key
    method: String, // card, upi, netbanking
    status: {
      type: String,
      enum: ['CAPTURED', 'FAILED', 'REFUNDED', 'PARTIAL_REFUND'],
      index: true,
    },
    capturedAt: Date,
    refundedAt: Date,
    refundAmount: Number,
  },
  baseSchemaOptions,
);

export type SubscriptionPaymentAttrs = InferSchemaType<typeof SubscriptionPaymentSchema>;
export type SubscriptionPaymentDoc = HydratedDocument<SubscriptionPaymentAttrs>;
export const SubscriptionPaymentModel: Model<SubscriptionPaymentAttrs> =
  model<SubscriptionPaymentAttrs>(
    'SubscriptionPayment',
    SubscriptionPaymentSchema,
    'subscription_payments',
  );
export { SubscriptionPaymentSchema };
