/**
 * Contract between AuthService and whichever OTP sender is live.
 *
 * Two concrete implementations will land in Chunk 3:
 *   - DevConsoleOtpService (logs the OTP, used until MSG91 is wired)
 *   - Msg91OtpService (DLT-registered SMS, prod)
 *
 * Kept as a separate file so Chunk 3 can drop in `otp.service.ts`
 * without having to rewrite auth.service imports.
 */
export type OtpPurpose = 'SIGNUP' | 'LOGIN' | 'PHONE_CHANGE' | 'EMAIL_CHANGE';

export interface OtpSendInput {
  phone: string;
  purpose: OtpPurpose;
  ipAddress: string;
  deviceFingerprint: string | null;
}

export interface OtpVerifyInput {
  phone: string;
  otp: string;
  purpose: OtpPurpose;
}

export interface OtpService {
  /**
   * Issue a fresh OTP, hash it into `otp_verifications`, and dispatch
   * via SMS (or log via dev-console). Resolves when the OTP is in
   * flight; rejects only on infrastructure / lockout errors. Phone
   * enumeration is prevented at the *caller* (auth.service) — `send`
   * itself does not gate on user existence.
   */
  send(input: OtpSendInput): Promise<void>;

  /**
   * Verify an OTP attempt. Increments attempts, rejects on
   * wrong/expired/consumed, flips `consumedAt` on success. Throws
   * a typed AppError subclass on failure.
   */
  verify(input: OtpVerifyInput): Promise<void>;
}

/**
 * SMS-channel adapter. Implemented by DevConsoleSender (logs OTP)
 * and Msg91Sender (DLT-registered SMS via MSG91 flow API). The
 * OtpServiceImpl composes one of these with the LockoutStore and
 * the `otp_verifications` repository.
 */
export interface OtpSender {
  send(phone: string, otp: string, purpose: OtpPurpose): Promise<void>;
}
