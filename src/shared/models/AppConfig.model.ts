import { Schema, model, type HydratedDocument, type InferSchemaType, type Model } from 'mongoose';
import { baseSchemaOptions } from './_base.js';

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
    kycThresholdAmount: { type: Number, default: 10_000 }, // paise (₹100)
    ageMin: { type: Number, default: 18 },
    maintenanceMode: { type: Boolean, default: false },
    featureFlags: Schema.Types.Mixed,

    // Razorpay plan IDs written by scripts/migrate-razorpay-plans.ts
    // so admins can swap plans without a redeploy.
    razorpayPlanIds: {
      PRO: String,
      PRO_MAX: String,
    },
  },
  baseSchemaOptions,
);

export type AppConfigAttrs = InferSchemaType<typeof AppConfigSchema>;
export type AppConfigDoc = HydratedDocument<AppConfigAttrs>;
export const AppConfigModel: Model<AppConfigAttrs> = model<AppConfigAttrs>(
  'AppConfig',
  AppConfigSchema,
  'app_config',
);
export { AppConfigSchema };
