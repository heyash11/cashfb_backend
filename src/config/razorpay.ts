import Razorpay from 'razorpay';
import { env } from './env.js';
import { logger } from './logger.js';

/**
 * Lazily-constructed Razorpay SDK client. Prod boot fails via env
 * superRefine if `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` are
 * missing; dev/test may omit them and defer the client construction
 * (services accept an optional `razorpay` dep for fakes).
 */
let cached: Razorpay | undefined;

export function getRazorpayClient(): Razorpay {
  if (cached) return cached;
  if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) {
    throw new Error(
      'RAZORPAY_KEY_ID or RAZORPAY_KEY_SECRET is not set. Configure your .env or inject a fake client.',
    );
  }
  if (!env.RAZORPAY_KEY_ID.startsWith('rzp_test_') && env.NODE_ENV !== 'production') {
    logger.warn({ keyId: env.RAZORPAY_KEY_ID }, '[razorpay] non-test key in non-prod env');
  }
  cached = new Razorpay({
    key_id: env.RAZORPAY_KEY_ID,
    key_secret: env.RAZORPAY_KEY_SECRET,
  });
  return cached;
}
