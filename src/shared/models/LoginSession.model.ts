import { Schema, model, Types, type HydratedDocument, type Model } from 'mongoose';
import { baseSchemaOptions } from './_base.js';

export interface LoginSessionAttrs {
  _id: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
  userId: Types.ObjectId;
  jti: string;
  // Schema leaves these unrequired; code always populates them. The
  // defensive null-checks in auth.service.ts match the schema's
  // permissiveness (belt-and-braces).
  deviceId?: string;
  deviceFingerprint?: string;
  userAgent?: string;
  ip?: string;
  refreshTokenHash?: string;
  family?: string;
  revokedAt?: Date;
  expiresAt?: Date;
}

const LoginSessionSchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: 'User', required: true, index: true },
    jti: { type: String, required: true, unique: true },
    deviceId: String,
    deviceFingerprint: String,
    userAgent: String,
    ip: String,
    refreshTokenHash: String, // sha256 of refresh token
    family: String, // rotation family id
    revokedAt: Date,
    expiresAt: Date,
  },
  baseSchemaOptions,
);

LoginSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // TTL auto-cleanup
LoginSessionSchema.index({ userId: 1, revokedAt: 1 }); // active sessions lookup

export type LoginSessionDoc = HydratedDocument<LoginSessionAttrs>;
export const LoginSessionModel: Model<LoginSessionAttrs> = model<LoginSessionAttrs>(
  'LoginSession',
  LoginSessionSchema,
  'login_sessions',
);
export { LoginSessionSchema };
