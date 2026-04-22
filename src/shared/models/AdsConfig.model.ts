import { Schema, model, Types, type HydratedDocument, type Model } from 'mongoose';
import { baseSchemaOptions } from './_base.js';

export interface AdsConfigAttrs {
  _id: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
  placementKey: string;
  type: 'BANNER' | 'INTERSTITIAL' | 'REWARDED_VIDEO' | 'NATIVE';
  network: 'ADMOB' | 'UNITY' | 'APPLOVIN' | 'IRONSOURCE';
  adUnitIdAndroid?: string;
  adUnitIdIOS?: string;
  fallbackAdUnitId?: string;
  enabled: boolean;
  minTierToHide: 'NONE' | 'PRO' | 'PRO_MAX';
  refreshSeconds?: number;
  updatedBy?: Types.ObjectId;
}

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

export type AdsConfigDoc = HydratedDocument<AdsConfigAttrs>;
export const AdsConfigModel: Model<AdsConfigAttrs> = model<AdsConfigAttrs>(
  'AdsConfig',
  AdsConfigSchema,
  'ads_config',
);
export { AdsConfigSchema };
