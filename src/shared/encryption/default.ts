import { env } from '../../config/env.js';
import type { Encryptor } from './envelope.js';
import { InMemoryEncryptor } from './in-memory.js';
import { KmsEncryptor } from './kms.js';

/**
 * Process-wide encryptor singleton.
 *
 * Before Phase 9 Chunk 5, `AdminRedeemCodeService` and
 * `RedeemCodeService` each defined their own `defaultEncryptor()`
 * that called `new InMemoryEncryptor()` on demand. Under the same
 * process, admin-upload and user-claim therefore encrypted +
 * decrypted with TWO different ephemeral KEKs → decrypt failed at
 * claim time with "Unsupported state or unable to authenticate
 * data". Caught during Chunk 5 k6 fcfs-race smoke.
 *
 * Correct behaviour: both services share a single encryptor per
 * process. `KmsEncryptor` is safe to share (stateless client).
 * `InMemoryEncryptor` MUST be shared or its per-instance
 * random KEK means nothing encrypted by one can be decrypted by
 * another.
 *
 * Production posture: KMS_KEY_ID + AWS_REGION set → KmsEncryptor.
 * Dev/test: either unset → a single InMemoryEncryptor for the
 * lifetime of the process.
 */
let cached: Encryptor | undefined;

export function getDefaultEncryptor(): Encryptor {
  if (cached) return cached;
  if (env.KMS_KEY_ID && env.AWS_REGION) {
    cached = new KmsEncryptor({ region: env.AWS_REGION, keyId: env.KMS_KEY_ID });
  } else {
    cached = new InMemoryEncryptor();
  }
  return cached;
}

/** Test-only: reset the singleton. Not exported through index.ts. */
export function __resetDefaultEncryptorForTest(): void {
  cached = undefined;
}
