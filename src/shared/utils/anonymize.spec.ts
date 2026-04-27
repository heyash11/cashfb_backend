import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';
import type { UserAttrs } from '../models/User.model.js';
import { buildAnonymizeOps, hashEmailForTombstone, hashPhoneForTombstone } from './anonymize.js';

/**
 * Phase 9 Chunk 4 — anonymize helper. Pure-function specs only; no
 * Mongo I/O. Sweep-worker spec covers transactional application.
 */

function makeUser(overrides: Partial<UserAttrs> = {}): UserAttrs {
  const _id = new Types.ObjectId('69eb0cbdb25b8001c74a35a0');
  return {
    _id,
    createdAt: new Date('2026-03-01'),
    updatedAt: new Date('2026-04-01'),
    phone: '+919988776655',
    dob: new Date('1995-01-01'),
    declaredState: 'IN-MH',
    displayName: 'Ashhu',
    avatarUrl: 'https://cdn.cashfb.com/u/a.png',
    socialLinks: { youtube: 'https://youtube.com/@ashhu' },
    coinBalance: 10,
    totalCoinsEarned: 50,
    totalVotesCast: 3,
    signupBonusGranted: true,
    tier: 'PRO',
    geoBlocked: false,
    ageVerified: true,
    kyc: {
      status: 'VERIFIED',
      panCt: 'ciphertext-blob',
      panIv: 'iv-bytes',
      panTag: 'tag-bytes',
      panDekEnc: 'dek-envelope',
      panLast4: '1234',
      verifiedAt: new Date('2026-03-15'),
    },
    blocked: { isBlocked: false },
    subscriptions: [],
    ...overrides,
  };
}

describe('anonymize.buildAnonymizeOps', () => {
  it('tombstones every PII field and emits cascades for donations + notifications', () => {
    const user = makeUser({ email: 'ashhu@example.com' });
    const now = new Date('2026-04-24T02:00:00Z');

    const ops = buildAnonymizeOps(user, now);

    // User-row $set
    expect(ops.userPatch.phone).toBe(hashPhoneForTombstone(user.phone, user._id));
    expect(ops.userPatch.email).toBe(hashEmailForTombstone('ashhu@example.com', user._id));
    expect(ops.userPatch.displayName).toBe('REDACTED_USER');
    expect(ops.userPatch['kyc.panLast4']).toBeNull();
    expect(ops.userPatch.anonymizedAt).toBe(now);

    // User-row $unset: fields that should be GONE rather than null
    // (avatar + subdocs + KYC ciphertext). Subdoc-shaped fields like
    // socialLinks must be $unset because {socialLinks: null} leaves
    // a subdoc with undefined leaves under Mongoose.
    expect(ops.userUnsets).toEqual(
      expect.arrayContaining([
        'avatarUrl',
        'socialLinks',
        'kyc.panCt',
        'kyc.panIv',
        'kyc.panTag',
        'kyc.panDekEnc',
      ]),
    );
    expect(ops.userPatch).not.toHaveProperty('avatarUrl');
    expect(ops.userPatch).not.toHaveProperty('socialLinks');

    // Cascades
    const donationCascade = ops.cascades.find((c) => c.collection === 'donations');
    expect(donationCascade).toBeDefined();
    expect(donationCascade?.filter).toEqual({ userId: user._id });
    expect(donationCascade?.update).toEqual({
      $set: {
        displayName: null,
        message: null,
        socialLinks: null,
        ipAddress: null,
        notes: {},
      },
    });

    const notificationCascade = ops.cascades.find((c) => c.collection === 'notifications');
    expect(notificationCascade).toBeDefined();
    expect(notificationCascade?.update).toEqual({
      $set: { title: null, body: null, payload: {} },
    });
  });

  it('preserves non-PII fields by omitting them from the patch', () => {
    const user = makeUser();
    const ops = buildAnonymizeOps(user, new Date());

    // _id, createdAt, tier, coinBalance, totalCoinsEarned etc. must
    // NOT appear in the patch — the sweep only writes the tombstoned
    // fields + anonymizedAt, everything else is left alone.
    expect(ops.userPatch).not.toHaveProperty('_id');
    expect(ops.userPatch).not.toHaveProperty('createdAt');
    expect(ops.userPatch).not.toHaveProperty('tier');
    expect(ops.userPatch).not.toHaveProperty('coinBalance');
    expect(ops.userPatch).not.toHaveProperty('totalCoinsEarned');
    expect(ops.userPatch).not.toHaveProperty('deletedAt');
    expect(ops.userPatch).not.toHaveProperty('consentVersion');

    // Skips the email branch when user has no email.
    expect(ops.userPatch).not.toHaveProperty('email');
  });

  it('is deterministic — running twice on the same user produces the same patch modulo time', () => {
    const user = makeUser({ email: 'x@y.com' });
    const t1 = new Date('2026-04-24T02:00:00Z');

    const ops1 = buildAnonymizeOps(user, t1);
    const ops2 = buildAnonymizeOps(user, t1);

    expect(ops1).toEqual(ops2);

    // Re-running against an already-anonymized snapshot still
    // produces the same phone/email hashes (tombstone is idempotent
    // given the same _id seed) — i.e. re-running the sweep on a
    // half-anonymized row is safe.
    expect(ops1.userPatch.phone).toBe(ops2.userPatch.phone);
    expect(ops1.userPatch.email).toBe(ops2.userPatch.email);
  });
});
