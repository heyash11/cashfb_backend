import { Schema, model, type HydratedDocument, type Model, type Types } from 'mongoose';
import { baseSchemaOptions } from './_base.js';

export interface AppConfigVoteWindowIst {
  start: string;
  end: string;
}

export interface AppConfigRazorpayPlanIds {
  PRO?: string;
  PRO_MAX?: string;
}

export interface AppConfigAttrs {
  _id: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
  key: string;
  baseRatePerVote: number;
  signupBonusCoins: number;
  coinsPerPost: number;
  coinsPerVote: number;
  giftCodeDenomination: number;
  proMultiplier: number;
  proMaxMultiplier: number;
  voteWindowIst: AppConfigVoteWindowIst;
  blockedStates: string[];
  kycThresholdAmount: number;
  ageMin: number;
  maintenanceMode: boolean;
  /**
   * Arbitrary feature-flag map. Shape varies by flag name; consumers
   * narrow at the access site.
   */
  featureFlags?: Record<string, unknown>;
  razorpayPlanIds?: AppConfigRazorpayPlanIds;
  /**
   * Tenant-wide IP allowlist for the admin surface. Phase 8 middleware
   * stack rejects any /api/v1/admin/* request from an IP not in this
   * list (empty list = permissive; dev/staging fallback). Per-admin
   * `ipAllowlist` narrows further (AND-intersection semantic).
   */
  adminIpAllowlist: string[];
}

const AppConfigSchema = new Schema(
  {
    key: { type: String, default: 'default', unique: true },

    // Coin economy
    baseRatePerVote: { type: Number, default: 100 }, // paise per vote (₹1)
    signupBonusCoins: { type: Number, default: 3 },
    coinsPerPost: { type: Number, default: 1 },
    coinsPerVote: { type: Number, default: 3 },
    giftCodeDenomination: { type: Number, default: 5000 }, // paise (₹50)

    // Multipliers
    proMultiplier: { type: Number, default: 5 },
    proMaxMultiplier: { type: Number, default: 10 },

    // Voting window (IST)
    voteWindowIst: {
      start: { type: String, default: '00:00' },
      end: { type: String, default: '23:59' },
    },

    // Compliance
    blockedStates: { type: [String], default: [] }, // ISO 3166-2:IN codes
    // Phase 8 §KYC default: ₹10,000 (1,000,000 paise). Existing
    // environments with the old ₹100 default must run the mongosh
    // migration documented in ADMIN_OPERATIONS.md §Setup — the
    // schema default only applies on insert, not update.
    kycThresholdAmount: { type: Number, default: 1_000_000 },
    ageMin: { type: Number, default: 18 },
    maintenanceMode: { type: Boolean, default: false },
    featureFlags: Schema.Types.Mixed,

    // Razorpay plan IDs written by scripts/migrate-razorpay-plans.ts
    // so admins can swap plans without a redeploy.
    razorpayPlanIds: {
      PRO: String,
      PRO_MAX: String,
    },

    // Tenant-wide admin IP allowlist (Phase 8). Empty default = all IPs
    // allowed. Per-admin `admin_users.ipAllowlist` narrows further.
    adminIpAllowlist: { type: [String], default: [] },
  },
  baseSchemaOptions,
);

export type AppConfigDoc = HydratedDocument<AppConfigAttrs>;
export const AppConfigModel: Model<AppConfigAttrs> = model<AppConfigAttrs>(
  'AppConfig',
  AppConfigSchema,
  'app_config',
);
export { AppConfigSchema };
