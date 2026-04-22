import { Schema, model, Types, type HydratedDocument, type Model } from 'mongoose';
import { baseSchemaOptions } from './_base.js';

export interface DeviceFingerprintAttrs {
  _id: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
  fingerprint: string;
  androidId?: string;
  imeiHash?: string; // NEVER raw IMEI
  firstSeenUserId?: Types.ObjectId;
  linkedUserIds: Types.ObjectId[];
  suspiciousScore: number;
  blocked: boolean;
}

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

export type DeviceFingerprintDoc = HydratedDocument<DeviceFingerprintAttrs>;
export const DeviceFingerprintModel: Model<DeviceFingerprintAttrs> = model<DeviceFingerprintAttrs>(
  'DeviceFingerprint',
  DeviceFingerprintSchema,
  'device_fingerprints',
);
export { DeviceFingerprintSchema };
