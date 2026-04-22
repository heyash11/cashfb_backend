import { logger } from '../../config/logger.js';
import type { OtpPurpose, OtpSender } from './otp.types.js';

/**
 * Default sender. Logs the OTP instead of dispatching SMS so Ashhu
 * can exercise the full auth flow locally without MSG91 credentials.
 *
 * Selected by OTP_SENDER=dev-console (the default in .env.example).
 *
 * Obviously do NOT ship this to production. The factory refuses to
 * wire it when NODE_ENV=production and OTP_SENDER is not explicitly
 * set to `msg91`.
 */
export class DevConsoleSender implements OtpSender {
  async send(phone: string, otp: string, purpose: OtpPurpose): Promise<void> {
    logger.warn(
      { phone, otp, purpose },
      '[otp:dev-console] OTP not sent via SMS — logged here for local use. DO NOT use in production.',
    );
  }
}
