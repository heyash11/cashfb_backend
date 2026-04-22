import { Schema, model, type HydratedDocument, type InferSchemaType, type Model } from 'mongoose';
import { baseSchemaOptions } from './_base.js';

const AdminUserSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true }, // bcrypt cost 12
    name: String,
    role: {
      type: String,
      enum: ['SUPER_ADMIN', 'CONTENT_ADMIN', 'PAYMENT_ADMIN', 'SUPPORT_ADMIN'],
      required: true,
      index: true,
    },
    permissions: { type: [String], default: [] },
    twoFactor: {
      enabled: { type: Boolean, default: false },
      secret: String, // TOTP, encrypted via envelope helper at rest
      recoveryCodes: { type: [String], default: [] },
    },
    ipAllowlist: { type: [String], default: [] },
    lastLoginAt: Date,
    lastLoginIp: String,
    disabled: { type: Boolean, default: false },
  },
  baseSchemaOptions,
);

export type AdminUserAttrs = InferSchemaType<typeof AdminUserSchema>;
export type AdminUserDoc = HydratedDocument<AdminUserAttrs>;
export const AdminUserModel: Model<AdminUserAttrs> = model<AdminUserAttrs>(
  'AdminUser',
  AdminUserSchema,
  'admin_users',
);
export { AdminUserSchema };
