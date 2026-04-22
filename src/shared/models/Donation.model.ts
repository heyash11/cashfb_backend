import { Schema, model, Types, type HydratedDocument, type Model } from 'mongoose';
import { baseSchemaOptions } from './_base.js';
import type { SocialLinks } from './_shared.js';

export interface DonationAttrs {
  _id: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
  /** null/absent for anonymous donations. */
  userId?: Types.ObjectId;
  displayName?: string;
  isAnonymous: boolean;
  amount: number; // paise
  razorpayOrderId: string;
  razorpayPaymentId?: string;
  status: 'CREATED' | 'CAPTURED' | 'FAILED' | 'REFUNDED';
  message?: string;
  socialLinks?: SocialLinks;
  capturedAt?: Date;
  ipAddress?: string;
  /** Razorpay webhook notes; shape varies per event. */
  notes?: Record<string, unknown>;
}

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

export type DonationDoc = HydratedDocument<DonationAttrs>;
export const DonationModel: Model<DonationAttrs> = model<DonationAttrs>(
  'Donation',
  DonationSchema,
  'donations',
);
export { DonationSchema };
