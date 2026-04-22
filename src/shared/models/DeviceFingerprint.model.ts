import {
  Schema,
  model,
  Types,
  type HydratedDocument,
  type InferSchemaType,
  type Model,
} from 'mongoose';
import { baseSchemaOptions } from './_base.js';

const DeviceFingerprintSchema = new Schema(
  {
    fingerprint: { type: String, required: true, unique: true },
    androidId: String,
    imeiHash: String, // NEVER raw IMEI
    firstSeenUserId: { type: Types.ObjectId, ref: 'User' },
    linkedUserIds: [{ type: Types.ObjectId, ref: 'User' }],
    suspiciousScore: { type: Number, default: 0 },
    blocked: { type: Boolean, default: false },
  },
  baseSchemaOptions,
);

DeviceFingerprintSchema.index({ blocked: 1 }); // anti-fraud scan

export type DeviceFingerprintAttrs = InferSchemaType<typeof DeviceFingerprintSchema>;
export type DeviceFingerprintDoc = HydratedDocument<DeviceFingerprintAttrs>;
export const DeviceFingerprintModel: Model<DeviceFingerprintAttrs> = model<DeviceFingerprintAttrs>(
  'DeviceFingerprint',
  DeviceFingerprintSchema,
  'device_fingerprints',
);
export { DeviceFingerprintSchema };
