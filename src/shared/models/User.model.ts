import { Schema, model, Types, type HydratedDocument, type Model } from 'mongoose';
import { baseSchemaOptions } from './_base.js';
import type { SocialLinks } from './_shared.js';

export interface UserKyc {
  status: 'NONE' | 'PENDING' | 'VERIFIED' | 'REJECTED';
  panCt?: string;
  panIv?: string;
  panTag?: string;
  panDekEnc?: string;
  panLast4?: string;
  verifiedAt?: Date;
}

export interface UserBlocked {
  isBlocked: boolean;
  reason?: string;
  at?: Date;
  by?: Types.ObjectId;
}

export interface UserAttrs {
  _id: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;

  // Schema-level required.
  phone: string;
  dob: Date;
  declaredState: string;

  // Truly optional.
  email?: string;
  displayName?: string;
  avatarUrl?: string;
  socialLinks?: SocialLinks;

  // Defaulted at schema level → always present on read.
  coinBalance: number;
  totalCoinsEarned: number;
  totalVotesCast: number;
  signupBonusGranted: boolean;
  tier: 'PUBLIC' | 'PRO' | 'PRO_MAX';
  geoBlocked: boolean;
  ageVerified: boolean;

  // Subdocs with inner defaults → subdoc materialised → required.
  kyc: UserKyc;
  blocked: UserBlocked;

  // Optional, set over time.
  lastVoteDate?: string;
  activeSubscriptionId?: Types.ObjectId;
  tierExpiresAt?: Date;
  primaryDeviceFingerprint?: string;
  lastLoginIp?: string;
  lastLoginAt?: Date;
  referredBy?: Types.ObjectId;
  referralCode?: string;

  // DPDP consent artefact (Phase 2 ambiguity #1). Optional because
  // pre-Phase-2 test fixtures may not carry them.
  consentVersion?: string;
  consentAcceptedAt?: Date;
  privacyPolicyVersion?: string;
}

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

    // DPDP consent artefact (captured at signup). Flutter sends
    // current versions in the verify payload; we store for audit.
    consentVersion: String,
    consentAcceptedAt: Date,
    privacyPolicyVersion: String,
  },
  baseSchemaOptions,
);

UserSchema.index({ tier: 1, tierExpiresAt: 1 }); // tier + expiry sweep
UserSchema.index({ declaredState: 1, geoBlocked: 1 }); // geo-block check
UserSchema.index({ 'blocked.isBlocked': 1 }); // block enforcement
UserSchema.index({ 'kyc.panLast4': 1 }); // admin PAN search

export type UserDoc = HydratedDocument<UserAttrs>;
export const UserModel: Model<UserAttrs> = model<UserAttrs>('User', UserSchema, 'users');
export { UserSchema };
