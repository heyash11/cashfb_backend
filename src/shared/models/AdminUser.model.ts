import { Schema, model, type HydratedDocument, type Model, type Types } from 'mongoose';
import { baseSchemaOptions } from './_base.js';

export interface AdminUserTwoFactor {
  enabled: boolean;
  secret?: string; // TOTP, encrypted at rest
  recoveryCodes: string[];
}

export interface AdminUserAttrs {
  _id: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
  email: string;
  passwordHash: string;
  name?: string;
  role: 'SUPER_ADMIN' | 'CONTENT_ADMIN' | 'PAYMENT_ADMIN' | 'SUPPORT_ADMIN';
  permissions: string[];
  twoFactor: AdminUserTwoFactor;
  ipAllowlist: string[];
  lastLoginAt?: Date;
  lastLoginIp?: string;
  disabled: boolean;
}

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
      secret: String,
      recoveryCodes: { type: [String], default: [] },
    },
    ipAllowlist: { type: [String], default: [] },
    lastLoginAt: Date,
    lastLoginIp: String,
    disabled: { type: Boolean, default: false },
  },
  baseSchemaOptions,
);

export type AdminUserDoc = HydratedDocument<AdminUserAttrs>;
export const AdminUserModel: Model<AdminUserAttrs> = model<AdminUserAttrs>(
  'AdminUser',
  AdminUserSchema,
  'admin_users',
);
export { AdminUserSchema };
