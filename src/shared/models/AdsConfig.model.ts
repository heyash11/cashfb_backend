import {
  Schema,
  model,
  Types,
  type HydratedDocument,
  type InferSchemaType,
  type Model,
} from 'mongoose';
import { baseSchemaOptions } from './_base.js';

/**
 * Ad placement keys:
 *  'home_top_banner', 'timer_top_banner', 'timer_bottom_banner',
 *  'redeem_code_bottom_banner', 'custom_room_bottom_banner',
 *  'result_middle_banner'
 */
const AdsConfigSchema = new Schema(
  {
    placementKey: { type: String, required: true, unique: true },
    type: {
      type: String,
      enum: ['BANNER', 'INTERSTITIAL', 'REWARDED_VIDEO', 'NATIVE'],
      required: true,
    },
    network: {
      type: String,
      enum: ['ADMOB', 'UNITY', 'APPLOVIN', 'IRONSOURCE'],
      required: true,
    },
    adUnitIdAndroid: String,
    adUnitIdIOS: String,
    fallbackAdUnitId: String,
    enabled: { type: Boolean, default: true },
    minTierToHide: {
      type: String,
      enum: ['NONE', 'PRO', 'PRO_MAX'],
      default: 'NONE',
    },
    refreshSeconds: Number,
    updatedBy: { type: Types.ObjectId, ref: 'AdminUser' },
  },
  baseSchemaOptions,
);

export type AdsConfigAttrs = InferSchemaType<typeof AdsConfigSchema>;
export type AdsConfigDoc = HydratedDocument<AdsConfigAttrs>;
export const AdsConfigModel: Model<AdsConfigAttrs> = model<AdsConfigAttrs>(
  'AdsConfig',
  AdsConfigSchema,
  'ads_config',
);
export { AdsConfigSchema };
