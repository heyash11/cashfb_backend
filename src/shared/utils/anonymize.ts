import { createHash } from 'node:crypto';
import type { Types } from 'mongoose';
import type { UserAttrs } from '../models/User.model.js';

/**
 * DPDP anonymization helper (Phase 9 Chunk 4 — see docs/DPDP.md).
 *
 * Pure function. Produces a description of the writes the sweep
 * worker must apply, but does NOT touch Mongo itself. The worker
 * composes these ops into a single transaction so the user-row
 * tombstoning, the cascades into dependent collections, and the
 * audit row are either all applied or all rolled back.
 *
 * Design choice: this helper is I/O-free so it can be unit-tested
 * without docker. The sweep-worker spec covers the transactional
 * application; this spec covers the shape of the patch.
 */

export interface AnonymizeOps {
  /** `$set` payload for the user row. */
  userPatch: Record<string, unknown>;
  /** Field paths to `$unset` on the user row (KYC ciphertext etc.). */
  userUnsets: string[];
  /** Mongoose updateMany ops fanned out to dependent collections. */
  cascades: AnonymizeCascade[];
}

export interface AnonymizeCascade {
  collection: 'donations' | 'notifications';
  filter: Record<string, unknown>;
  update: Record<string, unknown>;
}

/**
 * Phone tombstone hash. Deterministic per-row:
 *   sha256(phone + ':' + _id.toHexString())
 *
 * Why per-row determinism:
 *   - Same user disputing erasure later can re-derive the hash
 *     (requires the _id, which they can obtain via legal process
 *     against audit_logs).
 *   - No collision on `users.phone`'s unique index: every hash
 *     carries the _id, so two erasures of the same phone produce
 *     distinct hashes.
 *   - Precomputation resistance: an attacker who dumps `users` and
 *     wants to reverse hashes to phone numbers needs the _id AND
 *     the phone — they already have the _id from the row, so this
 *     only offers defence-in-depth against a partial leak of the
 *     phone field in isolation (e.g. a logging leak).
 *
 * No external salt in Phase 9 — deferred to Phase 10 legal review.
 */
export function hashPhoneForTombstone(phone: string, userId: Types.ObjectId): string {
  return createHash('sha256').update(`${phone}:${userId.toHexString()}`).digest('hex');
}

/**
 * Same hash scheme for email. Emails can be PII on their own, so we
 * tombstone them the same way. Users who never set an email
 * (signup is phone-only) skip this — the `$set` just writes null
 * over whatever was there.
 */
export function hashEmailForTombstone(email: string, userId: Types.ObjectId): string {
  return createHash('sha256')
    .update(`${email.toLowerCase()}:${userId.toHexString()}`)
    .digest('hex');
}

/**
 * Build the ops for anonymizing a user. Caller applies them inside
 * a Mongo transaction in the order: user $set + $unset first, then
 * cascades, then the LoginSession delete (handled by the worker,
 * not described here).
 */
export function buildAnonymizeOps(user: UserAttrs, now: Date): AnonymizeOps {
  const userPatch: Record<string, unknown> = {
    phone: hashPhoneForTombstone(user.phone, user._id),
    displayName: 'REDACTED_USER',
    'kyc.panLast4': null,
    anonymizedAt: now,
  };

  // Only write the email hash if the user actually had an email —
  // otherwise $set-ing null over an already-absent field still
  // creates the field on the document, which pollutes reads.
  if (typeof user.email === 'string' && user.email.length > 0) {
    userPatch.email = hashEmailForTombstone(user.email, user._id);
  }

  // `$unset` for fields we want GONE (not null-but-present). This is
  // important for subdoc-shaped fields like `socialLinks`: Mongoose
  // treats `{socialLinks: null}` as "subdoc with undefined leaves"
  // rather than a removed field, which pollutes reads. $unset is
  // unambiguous and matches the KYC-ciphertext treatment below.
  const userUnsets: string[] = [
    'avatarUrl',
    'socialLinks',
    // Drop the KYC ciphertext entirely. Retaining the plaintext last-
    // four would let an attacker probe `{kyc.panLast4: 'NNNN'}` + a
    // name guess to confirm identity after anonymization.
    'kyc.panCt',
    'kyc.panIv',
    'kyc.panTag',
    'kyc.panDekEnc',
  ];

  // Donation cascade. All donor-PII fields tombstoned; userId
  // preserved so revenue aggregation (`amount` + `status` +
  // `capturedAt`) still works. `notes` becomes `{}` (empty object)
  // rather than null to preserve the Mixed-type contract so
  // downstream readers never see a type surprise.
  const donationCascade: AnonymizeCascade = {
    collection: 'donations',
    filter: { userId: user._id },
    update: {
      $set: {
        displayName: null,
        message: null,
        socialLinks: null,
        ipAddress: null,
        notes: {},
      },
    },
  };

  // Notification cascade. userId preserved (for admin audit of who
  // was notified); title/body/payload cleared because payload can
  // carry prize amounts, OTP codes, etc.
  const notificationCascade: AnonymizeCascade = {
    collection: 'notifications',
    filter: { userId: user._id },
    update: {
      $set: {
        title: null,
        body: null,
        payload: {},
      },
    },
  };

  return {
    userPatch,
    userUnsets,
    cascades: [donationCascade, notificationCascade],
  };
}
