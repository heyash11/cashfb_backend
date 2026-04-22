import {
  Schema,
  model,
  Types,
  type HydratedDocument,
  type InferSchemaType,
  type Model,
} from 'mongoose';
import { baseSchemaOptions } from './_base.js';

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

export type LoginSessionAttrs = InferSchemaType<typeof LoginSessionSchema>;
export type LoginSessionDoc = HydratedDocument<LoginSessionAttrs>;
export const LoginSessionModel: Model<LoginSessionAttrs> = model<LoginSessionAttrs>(
  'LoginSession',
  LoginSessionSchema,
  'login_sessions',
);
export { LoginSessionSchema };
