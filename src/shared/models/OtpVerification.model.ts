import { Schema, model, type HydratedDocument, type InferSchemaType, type Model } from 'mongoose';
import { baseSchemaOptions } from './_base.js';

const OtpVerificationSchema = new Schema(
  {
    channel: { type: String, enum: ['SMS', 'EMAIL'], required: true },
    destination: { type: String, required: true, index: true },
    otpHash: { type: String, required: true }, // NEVER plaintext
    salt: String,
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 5 },
    purpose: {
      type: String,
      enum: ['SIGNUP', 'LOGIN', 'PHONE_CHANGE', 'EMAIL_CHANGE'],
    },
    ipAddress: String,
    deviceFingerprint: String,
    consumedAt: Date,
    expiresAt: { type: Date, required: true },
  },
  baseSchemaOptions,
);

OtpVerificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // TTL auto-cleanup
OtpVerificationSchema.index({ destination: 1, createdAt: -1 }); // latest OTP for phone/email

export type OtpVerificationAttrs = InferSchemaType<typeof OtpVerificationSchema>;
export type OtpVerificationDoc = HydratedDocument<OtpVerificationAttrs>;
export const OtpVerificationModel: Model<OtpVerificationAttrs> = model<OtpVerificationAttrs>(
  'OtpVerification',
  OtpVerificationSchema,
  'otp_verifications',
);
export { OtpVerificationSchema };
