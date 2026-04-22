import { Schema, model, Types, type HydratedDocument, type Model } from 'mongoose';
import { baseSchemaOptions } from './_base.js';

export interface SubscriptionAttrs {
  _id: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
  userId: Types.ObjectId;
  tier: 'PRO' | 'PRO_MAX';
  razorpaySubscriptionId: string;
  razorpayPlanId: string;
  razorpayCustomerId?: string;
  status:
    | 'CREATED'
    | 'AUTHENTICATED'
    | 'ACTIVE'
    | 'PENDING'
    | 'HALTED'
    | 'CANCELLED'
    | 'COMPLETED'
    | 'PAUSED';
  billingCycle: 'MONTHLY' | 'YEARLY';
  totalCount?: number;
  paidCount: number;
  remainingCount?: number;
  baseAmount?: number; // paise, pre-GST
  gstAmount?: number;
  totalAmount?: number;
  currentStart?: Date;
  currentEnd?: Date;
  chargeAt?: Date;
  startAt?: Date;
  endAt?: Date;
  autoRenew: boolean;
  cancelledAt?: Date;
  cancelReason?: string;
  /** Razorpay subscription-level metadata; shape varies per webhook event. */
  notes?: Record<string, unknown>;
}

const SubscriptionSchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: 'User', required: true, index: true },
    tier: { type: String, enum: ['PRO', 'PRO_MAX'], required: true },
    razorpaySubscriptionId: { type: String, required: true, unique: true },
    razorpayPlanId: { type: String, required: true },
    razorpayCustomerId: String,
    status: {
      type: String,
      enum: [
        'CREATED',
        'AUTHENTICATED',
        'ACTIVE',
        'PENDING',
        'HALTED',
        'CANCELLED',
        'COMPLETED',
        'PAUSED',
      ],
      required: true,
      index: true,
    },
    billingCycle: { type: String, enum: ['MONTHLY', 'YEARLY'], default: 'MONTHLY' },
    totalCount: Number,
    paidCount: { type: Number, default: 0 },
    remainingCount: Number,
    baseAmount: Number, // paise, pre-GST
    gstAmount: Number,
    totalAmount: Number,
    currentStart: Date,
    currentEnd: Date,
    chargeAt: Date,
    startAt: Date,
    endAt: Date,
    autoRenew: { type: Boolean, default: true },
    cancelledAt: Date,
    cancelReason: String,
    notes: Schema.Types.Mixed,
  },
  baseSchemaOptions,
);

SubscriptionSchema.index({ userId: 1, status: 1 }); // user's active sub lookup
SubscriptionSchema.index({ status: 1, currentEnd: 1 }); // expiry sweep

export type SubscriptionDoc = HydratedDocument<SubscriptionAttrs>;
export const SubscriptionModel: Model<SubscriptionAttrs> = model<SubscriptionAttrs>(
  'Subscription',
  SubscriptionSchema,
  'subscriptions',
);
export { SubscriptionSchema };
