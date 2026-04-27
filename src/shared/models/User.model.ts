import { Schema, model, Types, type HydratedDocument, type Model } from 'mongoose';
import { baseSchemaOptions } from './_base.js';
import type { SocialLinks } from './_shared.js';
import { SUBSCRIBABLE_TIER_VALUES, type SubscribableTier } from './_tier.js';

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

/**
 * DPDP erasure hold (Phase 9 Chunk 4). When `active: true`, the
 * anonymization sweep worker skips this user — used by ops to pause
 * a pending erasure while a legal / compliance review is in flight.
 * On clear, the sweep consumer advances `deletedAt` forward by the
 * held duration so the user does not lose their remaining grace.
 */
export interface UserErasureHold {
  active: boolean;
  reason?: string;
  by?: Types.ObjectId;
  at?: Date;
}

/**
 * Single entry in `User.subscriptions[]` (Phase 11.0). Each row
 * unlocks one tier section in parallel; an empty array means the
 * user is PUBLIC-only. Phase 11.3 will rework subscription webhook
 * handlers to push/update entries here keyed by tier; until then
 * the array is populated only by the Phase 11.0 backfill from
 * legacy `User.tier` + `activeSubscriptionId`.
 *
 * Status mirrors the 3-value client-facing enum used by /me — the
 * 8-value backend `Subscription.status` is mapped down at write
 * time so the array is directly UI-renderable.
 *
 * NOTE: MongoDB cannot enforce uniqueness within an array via a
 * single index. The "one entry per tier" invariant is a contract
 * on the writer (Phase 11.3 webhook handlers must $addToSet by
 * tier or do a guarded $set). Phase 11.0 backfill produces at
 * most one entry per user, so the invariant is intact at landing.
 */
export interface UserSubscriptionEntry {
  tier: SubscribableTier;
  status: 'ACTIVE' | 'CANCELLED' | 'EXPIRED';
  expiresAt?: Date;
  /** Pointer back to the canonical `Subscription` row (audit trail). */
  subscriptionId?: Types.ObjectId;
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
  /**
   * Phase 11.0 — parallel-tier subscription state. Defaulted to
   * `[]` at the schema layer so it's always present on read.
   * Legacy `tier` / `activeSubscriptionId` / `tierExpiresAt`
   * fields above remain authoritative until Phase 11.5; this
   * array is read by Phase 11.3+ writers and not yet by /me.
   */
  subscriptions: UserSubscriptionEntry[];
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

  // DPDP erasure state (Phase 9 Chunk 4 — see docs/DPDP.md).
  //
  // `deletedAt` is set when the user requests erasure; the sweep
  // worker tombstones the row 30 days after this timestamp (unless
  // cancelled by the user or held by ops).
  //
  // `anonymizedAt` is the terminal state. Once set, PII fields
  // (phone/email/displayName/avatarUrl/socialLinks/kyc.pan*) are
  // tombstoned in-place. The row itself is kept for referential
  // integrity against donations / coin_transactions / prize_pool_winners.
  deletedAt?: Date;
  anonymizedAt?: Date;
  erasureHold?: UserErasureHold;
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
    // Phase 11.0 — parallel-tier subscription array. See
    // UserSubscriptionEntry for the per-element shape and the
    // writer-side uniqueness contract. `default: []` so reads
    // always observe the array; pre-migration rows pick up an
    // empty array on first hydration.
    subscriptions: {
      type: [
        new Schema(
          {
            tier: {
              type: String,
              enum: SUBSCRIBABLE_TIER_VALUES,
              required: true,
            },
            status: {
              type: String,
              enum: ['ACTIVE', 'CANCELLED', 'EXPIRED'],
              required: true,
            },
            expiresAt: Date,
            subscriptionId: { type: Types.ObjectId, ref: 'Subscription' },
          },
          { _id: false },
        ),
      ],
      default: [],
    },

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

    // DPDP erasure (Phase 9 Chunk 4 — see docs/DPDP.md). The actual
    // index on `deletedAt` is a compound partial index declared below
    // (non-anonymized rows only) so the sweep scan is O(candidates).
    deletedAt: Date,
    anonymizedAt: { type: Date, index: true },
    erasureHold: {
      active: { type: Boolean, default: false },
      reason: String,
      by: { type: Types.ObjectId, ref: 'AdminUser' },
      at: Date,
    },
  },
  baseSchemaOptions,
);

UserSchema.index({ tier: 1, tierExpiresAt: 1 }); // tier + expiry sweep (legacy single-tier path)
// Phase 11.0 — multi-tier sweep query path for Phase 11.3+
// (`subscriptions[].expiresAt < now AND subscriptions[].status = 'ACTIVE'`).
// Multi-key index over the array fields.
UserSchema.index({ 'subscriptions.tier': 1, 'subscriptions.expiresAt': 1 });
UserSchema.index({ declaredState: 1, geoBlocked: 1 }); // geo-block check
UserSchema.index({ 'blocked.isBlocked': 1 }); // block enforcement
UserSchema.index({ 'kyc.panLast4': 1 }); // admin PAN search
// DPDP erasure sweep. The worker scans `deletedAt <= now - 30d`.
// Sparse index so live users (`deletedAt` absent — the vast
// majority) are not in the index at all. The sweep query filters
// anonymized + held rows in-application. MongoDB partial indexes
// do not support `$exists: false` as a filter, so we can't narrow
// the index further at the storage layer.
UserSchema.index({ deletedAt: 1 }, { sparse: true });

export type UserDoc = HydratedDocument<UserAttrs>;
export const UserModel: Model<UserAttrs> = model<UserAttrs>('User', UserSchema, 'users');
export { UserSchema };
