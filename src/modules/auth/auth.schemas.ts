import { z } from 'zod';

/**
 * E.164-ish Indian mobile. Accepts:
 *   +91XXXXXXXXXX
 *   91XXXXXXXXXX
 *   XXXXXXXXXX   (10 digits, starting 6-9)
 * Normalises to "+91XXXXXXXXXX" via .transform so downstream code
 * only ever sees one shape.
 */
const IndianPhoneSchema = z
  .string()
  .trim()
  .transform((raw, ctx) => {
    const digits = raw.replace(/\D/g, '');
    let last10: string;
    if (digits.length === 10) {
      last10 = digits;
    } else if (digits.length === 12 && digits.startsWith('91')) {
      last10 = digits.slice(2);
    } else {
      ctx.addIssue({ code: 'custom', message: 'Invalid Indian phone number' });
      return z.NEVER;
    }
    if (!/^[6-9]\d{9}$/.test(last10)) {
      ctx.addIssue({ code: 'custom', message: 'Indian mobiles start with 6, 7, 8 or 9' });
      return z.NEVER;
    }
    return `+91${last10}`;
  });

const OtpSchema = z.string().regex(/^\d{6}$/, 'OTP must be 6 digits');

const DeviceIdSchema = z.string().trim().min(1).max(128);
const DeviceFingerprintSchema = z.string().trim().min(1).max(256);

/** ISO 3166-2:IN state code, e.g. IN-MH, IN-KA, IN-DL. */
const DeclaredStateSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^IN-[A-Z]{2,3}$/, 'declaredState must be ISO 3166-2:IN, e.g. IN-MH');

const ReferralCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[0-9A-HJKMNP-TV-Z]{8}$/, 'referralCode is 8-char Crockford base32');

// ---- Bodies ----

export const RequestSignupOtpBodySchema = z
  .object({
    phone: IndianPhoneSchema,
    deviceId: DeviceIdSchema,
    deviceFingerprint: DeviceFingerprintSchema,
    /** Phase 9 Chunk 5 — same triple-gated load-test skip as /signup/verify. */
    _devBypassOtp: z.boolean().optional(),
  })
  .strict();

export const VerifySignupOtpBodySchema = z
  .object({
    phone: IndianPhoneSchema,
    otp: OtpSchema,
    /**
     * DOB as ISO date string. Coerced to Date. The 18+ gate runs in
     * the service (not the schema) so we can compute against IST.
     */
    dob: z.coerce.date(),
    declaredState: DeclaredStateSchema,
    referralCode: ReferralCodeSchema.optional(),
    /** DPDP consent artefact. Flutter sends the current versions. */
    consentVersion: z.string().trim().min(1),
    consentAcceptedAt: z.coerce.date(),
    privacyPolicyVersion: z.string().trim().min(1),
    deviceId: DeviceIdSchema,
    deviceFingerprint: DeviceFingerprintSchema,
    /**
     * Phase 9 Chunk 5 — load-test OTP bypass. Triply-gated:
     *   - env.NODE_ENV === 'development' (strict equality)
     *   - phone matches /^\+919999LOAD/
     *   - _devBypassOtp === true
     * Any one of the three failing falls back to standard OTP
     * verification. The field is allowed on the schema in all
     * environments but the service rejects it in non-dev.
     */
    _devBypassOtp: z.boolean().optional(),
  })
  .strict();

export const RequestLoginOtpBodySchema = z
  .object({
    phone: IndianPhoneSchema,
  })
  .strict();

export const VerifyLoginOtpBodySchema = z
  .object({
    phone: IndianPhoneSchema,
    otp: OtpSchema,
    deviceId: DeviceIdSchema,
    deviceFingerprint: DeviceFingerprintSchema,
  })
  .strict();

export const RefreshBodySchema = z
  .object({
    refreshToken: z.string().min(1),
  })
  .strict();

export const LogoutBodySchema = z
  .object({
    refreshToken: z.string().min(1),
  })
  .strict();

// ---- Inferred types ----

export type RequestSignupOtpBody = z.infer<typeof RequestSignupOtpBodySchema>;
export type VerifySignupOtpBody = z.infer<typeof VerifySignupOtpBodySchema>;
export type RequestLoginOtpBody = z.infer<typeof RequestLoginOtpBodySchema>;
export type VerifyLoginOtpBody = z.infer<typeof VerifyLoginOtpBodySchema>;
export type RefreshBody = z.infer<typeof RefreshBodySchema>;
export type LogoutBody = z.infer<typeof LogoutBodySchema>;
