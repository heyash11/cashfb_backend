import { z } from 'zod';

const AdTypeSchema = z.enum(['BANNER', 'INTERSTITIAL', 'REWARDED_VIDEO', 'NATIVE']);
const AdNetworkSchema = z.enum(['ADMOB', 'UNITY', 'APPLOVIN', 'IRONSOURCE']);
const MinTierSchema = z.enum(['NONE', 'PRO', 'PRO_MAX']);

export const AdminAdsConfigUpsertBodySchema = z
  .object({
    type: AdTypeSchema,
    network: AdNetworkSchema,
    adUnitIdAndroid: z.string().max(200).optional(),
    adUnitIdIOS: z.string().max(200).optional(),
    fallbackAdUnitId: z.string().max(200).optional(),
    enabled: z.boolean().optional(),
    minTierToHide: MinTierSchema.optional(),
    refreshSeconds: z.number().int().min(1).max(3600).optional(),
  })
  .strict();

export const AdminAdsConfigPlacementParamSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9_-]+$/i, 'placementKey must be alphanumeric + _ / -');

export type AdminAdsConfigUpsertBody = z.infer<typeof AdminAdsConfigUpsertBodySchema>;
