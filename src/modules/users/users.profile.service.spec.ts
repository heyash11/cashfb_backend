import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  clearAllCollections,
  connectTestMongo,
  disconnectTestMongo,
} from '../../../test/testing/mongo.js';
import { SubscriptionModel } from '../../shared/models/Subscription.model.js';
import { UserModel } from '../../shared/models/User.model.js';
import { UserProfileService } from './users.profile.service.js';

/**
 * Phase 9.6 — UserProfileService unit coverage. 11 specs lock the
 * /me payload contract:
 *   1   happy path — VERIFIED + ACTIVE subscription, full payload
 *   2-3 panLast4 omitted on non-VERIFIED kyc states
 *   4   panLast4 omitted on VERIFIED-but-empty edge case
 *   5   subscription omitted when activeSubscriptionId absent
 *   6   subscription omitted on CREATED/AUTHENTICATED/PENDING
 *   7   HALTED/PAUSED/CANCELLED-no-grace map to CANCELLED
 *   8   COMPLETED maps to EXPIRED
 *   9   CANCELLED + future tierExpiresAt → ACTIVE (grace)
 *   10  CANCELLED + past   tierExpiresAt → CANCELLED
 *   11  defense-in-depth: anonymized → 404, blocked → 403
 *   12  privacy: internal fields not in DTO
 */

beforeAll(async () => {
  await connectTestMongo();
}, 30_000);

afterAll(async () => {
  await disconnectTestMongo();
});

beforeEach(async () => {
  await clearAllCollections();
});

interface SeedSubscriptionInput {
  status:
    | 'CREATED'
    | 'AUTHENTICATED'
    | 'ACTIVE'
    | 'PENDING'
    | 'HALTED'
    | 'CANCELLED'
    | 'COMPLETED'
    | 'PAUSED';
  tier?: 'PRO' | 'PRO_MAX';
}

async function seedUser(
  overrides: Partial<{
    phone: string;
    tier: 'PUBLIC' | 'PRO' | 'PRO_MAX';
    coinBalance: number;
    displayName: string;
    avatarUrl: string;
    kycStatus: 'NONE' | 'PENDING' | 'VERIFIED' | 'REJECTED';
    panLast4: string;
    blocked: boolean;
    anonymizedAt: Date;
    tierExpiresAt: Date;
    subscription: SeedSubscriptionInput;
  }> = {},
): Promise<{ userId: Types.ObjectId }> {
  const userId = new Types.ObjectId();

  let activeSubscriptionId: Types.ObjectId | undefined;
  if (overrides.subscription) {
    const sub = await SubscriptionModel.create({
      userId,
      tier: overrides.subscription.tier ?? overrides.tier ?? 'PRO',
      razorpaySubscriptionId: `sub_${userId.toHexString()}`,
      razorpayPlanId: 'plan_test',
      status: overrides.subscription.status,
    });
    activeSubscriptionId = sub._id;
  }

  await UserModel.create({
    _id: userId,
    phone: overrides.phone ?? `+9198${Math.floor(Math.random() * 100_000_000)}`,
    dob: new Date('1995-01-01'),
    declaredState: 'IN-MH',
    tier: overrides.tier ?? 'PUBLIC',
    coinBalance: overrides.coinBalance ?? 3,
    ...(overrides.displayName ? { displayName: overrides.displayName } : {}),
    ...(overrides.avatarUrl ? { avatarUrl: overrides.avatarUrl } : {}),
    kyc: {
      status: overrides.kycStatus ?? 'NONE',
      ...(overrides.panLast4 ? { panLast4: overrides.panLast4 } : {}),
    },
    blocked: { isBlocked: overrides.blocked ?? false },
    ...(overrides.anonymizedAt ? { anonymizedAt: overrides.anonymizedAt } : {}),
    ...(activeSubscriptionId ? { activeSubscriptionId } : {}),
    ...(overrides.tierExpiresAt ? { tierExpiresAt: overrides.tierExpiresAt } : {}),
  });

  return { userId };
}

describe('UserProfileService.getMe', () => {
  // Spec 1
  it('happy path — VERIFIED KYC + ACTIVE subscription returns full payload', async () => {
    const future = new Date('2027-12-31T00:00:00Z');
    const { userId } = await seedUser({
      phone: '+919876543210',
      tier: 'PRO',
      coinBalance: 42,
      displayName: 'Ashhu',
      avatarUrl: 'https://cdn.test/ashhu.png',
      kycStatus: 'VERIFIED',
      panLast4: '1234',
      tierExpiresAt: future,
      subscription: { status: 'ACTIVE', tier: 'PRO' },
    });

    const svc = new UserProfileService({ clock: () => new Date('2026-04-26T00:00:00Z') });
    const profile = await svc.getMe(userId);

    expect(profile.id).toBe(userId.toHexString());
    expect(profile.phone).toBe('+919876543210');
    expect(profile.tier).toBe('PRO');
    expect(profile.coinBalance).toBe(42);
    expect(profile.displayName).toBe('Ashhu');
    expect(profile.avatarUrl).toBe('https://cdn.test/ashhu.png');
    expect(profile.kyc.status).toBe('VERIFIED');
    expect(profile.kyc.panLast4).toBe('1234');
    expect(profile.subscription).toEqual({
      status: 'ACTIVE',
      expiresAt: future.toISOString(),
    });
  });

  // Spec 2
  it('panLast4 omitted when kyc.status is NONE', async () => {
    const { userId } = await seedUser({ kycStatus: 'NONE', panLast4: '9999' });
    const svc = new UserProfileService();
    const profile = await svc.getMe(userId);
    expect(profile.kyc.status).toBe('NONE');
    expect(profile.kyc.panLast4).toBeUndefined();
  });

  // Spec 3
  it('panLast4 omitted when kyc.status is PENDING or REJECTED (defense against historical leak)', async () => {
    const a = await seedUser({ kycStatus: 'PENDING', panLast4: '8888' });
    const b = await seedUser({ kycStatus: 'REJECTED', panLast4: '7777' });
    const svc = new UserProfileService();
    expect((await svc.getMe(a.userId)).kyc.panLast4).toBeUndefined();
    expect((await svc.getMe(b.userId)).kyc.panLast4).toBeUndefined();
  });

  // Spec 4
  it('panLast4 omitted when status is VERIFIED but value is unset', async () => {
    const { userId } = await seedUser({ kycStatus: 'VERIFIED' });
    const svc = new UserProfileService();
    const profile = await svc.getMe(userId);
    expect(profile.kyc.status).toBe('VERIFIED');
    expect(profile.kyc.panLast4).toBeUndefined();
  });

  // Spec 5
  it('subscription block omitted when activeSubscriptionId is absent', async () => {
    const { userId } = await seedUser({ tier: 'PUBLIC' });
    const svc = new UserProfileService();
    const profile = await svc.getMe(userId);
    expect(profile.subscription).toBeUndefined();
  });

  // Spec 6
  it('subscription block omitted for not-yet-usable backend states (CREATED/AUTHENTICATED/PENDING)', async () => {
    for (const status of ['CREATED', 'AUTHENTICATED', 'PENDING'] as const) {
      const { userId } = await seedUser({ tier: 'PRO', subscription: { status } });
      const svc = new UserProfileService();
      const profile = await svc.getMe(userId);
      expect(profile.subscription).toBeUndefined();
    }
  });

  // Spec 7
  it('HALTED + PAUSED + CANCELLED-no-grace map to CANCELLED', async () => {
    const past = new Date('2020-01-01T00:00:00Z');
    const svc = new UserProfileService({ clock: () => new Date('2026-04-26T00:00:00Z') });

    for (const status of ['HALTED', 'PAUSED'] as const) {
      const { userId } = await seedUser({ tier: 'PRO', subscription: { status } });
      const profile = await svc.getMe(userId);
      expect(profile.subscription?.status).toBe('CANCELLED');
    }

    const { userId: cancelledUid } = await seedUser({
      tier: 'PRO',
      tierExpiresAt: past,
      subscription: { status: 'CANCELLED' },
    });
    const cancelledProfile = await svc.getMe(cancelledUid);
    expect(cancelledProfile.subscription?.status).toBe('CANCELLED');
  });

  // Spec 8
  it('COMPLETED maps to EXPIRED', async () => {
    const { userId } = await seedUser({ tier: 'PRO', subscription: { status: 'COMPLETED' } });
    const svc = new UserProfileService();
    const profile = await svc.getMe(userId);
    expect(profile.subscription?.status).toBe('EXPIRED');
  });

  // Spec 9 — grace-period rule (§A1 verdict R1)
  it('CANCELLED with future tierExpiresAt → ACTIVE (grace period unlocks Pro features)', async () => {
    const future = new Date('2030-01-01T00:00:00Z');
    const now = new Date('2026-04-26T00:00:00Z');
    const { userId } = await seedUser({
      tier: 'PRO',
      tierExpiresAt: future,
      subscription: { status: 'CANCELLED' },
    });
    const svc = new UserProfileService({ clock: () => now });
    const profile = await svc.getMe(userId);
    expect(profile.subscription?.status).toBe('ACTIVE');
    expect(profile.subscription?.expiresAt).toBe(future.toISOString());
  });

  // Spec 10 — grace boundary (§A1 verdict R3 — boundary semantics)
  it('CANCELLED with tierExpiresAt = clock now → CANCELLED (grace already ended)', async () => {
    const now = new Date('2026-04-26T12:00:00Z');
    const { userId } = await seedUser({
      tier: 'PRO',
      tierExpiresAt: now,
      subscription: { status: 'CANCELLED' },
    });
    const svc = new UserProfileService({ clock: () => now });
    const profile = await svc.getMe(userId);
    // Boundary: tierExpiresAt > now? false (equal). Grace ended.
    expect(profile.subscription?.status).toBe('CANCELLED');
  });

  // Spec 11 — defense-in-depth
  it('throws 404 NOT_FOUND when anonymizedAt is set, 403 USER_BLOCKED when blocked', async () => {
    const a = await seedUser({ anonymizedAt: new Date() });
    const svc = new UserProfileService();
    await expect(svc.getMe(a.userId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      httpStatus: 404,
    });

    const b = await seedUser({ blocked: true });
    await expect(svc.getMe(b.userId)).rejects.toMatchObject({
      code: 'USER_BLOCKED',
      httpStatus: 403,
    });
  });

  // Spec 12 — privacy posture
  it('returned DTO does NOT carry internal fields (dob/declaredState/PAN-ciphertext/__v)', async () => {
    const { userId } = await seedUser({
      kycStatus: 'VERIFIED',
      panLast4: '1234',
    });
    // Add some PAN ciphertext + email fields directly to confirm
    // they don't leak via the projection.
    await UserModel.updateOne(
      { _id: userId },
      {
        $set: {
          'kyc.panCt': 'CIPHER',
          'kyc.panIv': 'IV',
          'kyc.panTag': 'TAG',
          'kyc.panDekEnc': 'DEK',
          email: 'leak@test.invalid',
          referralCode: 'XXXXXXXX',
        },
      },
    );

    const svc = new UserProfileService();
    const profile = await svc.getMe(userId);

    // Top-level
    expect(profile).not.toHaveProperty('dob');
    expect(profile).not.toHaveProperty('declaredState');
    expect(profile).not.toHaveProperty('email');
    expect(profile).not.toHaveProperty('referralCode');
    expect(profile).not.toHaveProperty('blocked');
    expect(profile).not.toHaveProperty('anonymizedAt');
    expect(profile).not.toHaveProperty('deletedAt');
    expect(profile).not.toHaveProperty('erasureHold');
    // Mongoose internals
    expect(profile).not.toHaveProperty('__v');
    expect(profile).not.toHaveProperty('createdAt');
    expect(profile).not.toHaveProperty('updatedAt');
    // KYC internals
    expect(profile.kyc).not.toHaveProperty('panCt');
    expect(profile.kyc).not.toHaveProperty('panIv');
    expect(profile.kyc).not.toHaveProperty('panTag');
    expect(profile.kyc).not.toHaveProperty('panDekEnc');
    expect(profile.kyc).not.toHaveProperty('verifiedAt');
  });
});
