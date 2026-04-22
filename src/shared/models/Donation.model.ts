import {
  Schema,
  model,
  Types,
  type HydratedDocument,
  type InferSchemaType,
  type Model,
} from 'mongoose';
import { baseSchemaOptions } from './_base.js';

const DonationSchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: 'User', index: true }, // null for anonymous
    displayName: String,
    isAnonymous: { type: Boolean, default: false },
    amount: { type: Number, required: true }, // paise
    razorpayOrderId: { type: String, required: true, unique: true },
    razorpayPaymentId: { type: String, index: true },
    status: {
      type: String,
      enum: ['CREATED', 'CAPTURED', 'FAILED', 'REFUNDED'],
      default: 'CREATED',
      index: true,
    },
    message: { type: String, maxlength: 500 },
    socialLinks: { youtube: String, facebook: String, instagram: String },
    capturedAt: Date,
    ipAddress: String,
    notes: Schema.Types.Mixed,
  },
  baseSchemaOptions,
);

DonationSchema.index({ userId: 1, status: 1, createdAt: -1 }); // user donation history
DonationSchema.index({ status: 1, amount: -1 }); // top-donor aggregation

export type DonationAttrs = InferSchemaType<typeof DonationSchema>;
export type DonationDoc = HydratedDocument<DonationAttrs>;
export const DonationModel: Model<DonationAttrs> = model<DonationAttrs>(
  'Donation',
  DonationSchema,
  'donations',
);
export { DonationSchema };
