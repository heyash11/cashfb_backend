import { randomBytes } from 'node:crypto';

/**
 * Crockford base32 alphabet. Omits I, L, O, U for readability
 * (no confusion between 1/I/L or 0/O). Widely used for short
 * human-copyable codes.
 */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Generate a Crockford base32 code from CSPRNG bytes.
 *
 * Default length 8 (per ambiguity #11: 8-char Crockford base32 for
 * `users.referralCode`). Uniqueness is the caller's responsibility —
 * the auth service retries on DB conflict via the unique+sparse
 * index on `users.referralCode`.
 *
 * 8 chars × 32 = 2^40 ≈ 1.1 trillion combos. Collisions are
 * negligible at CashFB's user scale; one retry on conflict is
 * overwhelmingly enough.
 */
export function generateReferralCode(length = 8): string {
  if (length <= 0) throw new Error('length must be positive');
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) {
    const byte = bytes[i];
    if (byte === undefined) throw new Error('unreachable: randomBytes short read');
    // Modulo bias is negligible given the alphabet length (32) divides 256 evenly.
    out += CROCKFORD[byte % CROCKFORD.length];
  }
  return out;
}

export const REFERRAL_CODE_ALPHABET = CROCKFORD;
