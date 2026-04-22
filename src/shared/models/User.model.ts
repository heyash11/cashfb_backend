import {
  Schema,
  model,
  Types,
  type HydratedDocument,
  type InferSchemaType,
  type Model,
} from 'mongoose';
import { baseSchemaOptions } from './_base.js';

const UserSchema = new Schema(
  {
    phone: { type: String, required: true, unique: true },
    email: { type: String, lowercase: true, trim: true, sparse: true, unique: true },
    displayName: { type: String, trim: true, maxlength: 60 },
    avatarUrl: String,
    dob: { type: Date, required: true },
    declaredState: { type: String, required: true, index: true }, // ISO 3166-2:IN e.g. IN-MH
    socialLinks: {
      youtube: String,
      facebook: String,
      instagram: String,
    },

    // Coin economy. coinBalance only mutated via $inc under transaction.
    coinBalance: { type: Number, default: 0, min: 0 },
    totalCoinsEarned: { type: Number, default: 0 },
    totalVotesCast: { type: Number, default: 0 },
    signupBonusGranted: { type: Boolean, default: false },
    lastVoteDate: { type: String, index: true }, // 'YYYY-MM-DD' IST

    // Subscription snapshot
    tier: {
      type: String,
      enum: ['PUBLIC', 'PRO', 'PRO_MAX'],
      default: 'PUBLIC',
      index: true,
    },
    activeSubscriptionId: { type: Types.ObjectId, ref: 'Subscription' },
    tierExpiresAt: { type: Date, index: true },

    // KYC (lazy capture before first payout over app_config.kycThresholdAmount).
    kyc: {
      status: {
        type: String,
        enum: ['NONE', 'PENDING', 'VERIFIED', 'REJECTED'],
        default: 'NONE',
        index: true,
      },
      panCt: String,
      panIv: String,
      panTag: String,
      panDekEnc: String,
      panLast4: String, // plaintext for display only
      verifiedAt: Date,
    },

    // Compliance
    geoBlocked: { type: Boolean, default: false, index: true },
    ageVerified: { type: Boolean, default: false },
    blocked: {
      isBlocked: { type: Boolean, default: false },
      reason: String,
      at: Date,
      by: { type: Types.ObjectId, ref: 'AdminUser' },
    },

    // Anti-fraud
    primaryDeviceFingerprint: { type: String, index: true },
    lastLoginIp: String,
    lastLoginAt: Date,
    referredBy: { type: Types.ObjectId, ref: 'User', index: true },
    referralCode: { type: String, unique: true, sparse: true },
  },
  baseSchemaOptions,
);

UserSchema.index({ tier: 1, tierExpiresAt: 1 }); // tier + expiry sweep
UserSchema.index({ declaredState: 1, geoBlocked: 1 }); // geo-block check
UserSchema.index({ 'blocked.isBlocked': 1 }); // block enforcement
UserSchema.index({ 'kyc.panLast4': 1 }); // admin PAN search

export type UserAttrs = InferSchemaType<typeof UserSchema>;
export type UserDoc = HydratedDocument<UserAttrs>;
export const UserModel: Model<UserAttrs> = model<UserAttrs>('User', UserSchema, 'users');
export { UserSchema };
