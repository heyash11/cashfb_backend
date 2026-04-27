import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  clearAllCollections,
  connectTestMongo,
  disconnectTestMongo,
} from '../../../test/testing/mongo.js';
import { UserModel } from '../../shared/models/User.model.js';
import { UserProfileService } from './users.profile.service.js';

/**
 * Phase 11.5 — `/me` returns:
 *   - `subscriptions: SubscriptionEntry[]` (full array)
 *   - `currentTier: Tier` (derived display field)
 *   - NO `tier` (singular)
 *   - NO `subscription` (singular)
 *
 * The 12-spec Phase 9.6 matrix that exercised the old shape is
 * gone — those assertions tested fields that no longer exist.
 * The new specs below lock the Phase 11.5 contract.
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

const NOW = new Date('2026-04-27T00:00:00Z');
const FUTURE = new Date('2027-01-01T00:00:00Z');
const PAST = new Date('2026-01-01T00:00:00Z');

async function seedUser(
  overrides: Partial<{
    phone: string;
    displayName: string;
    avatarUrl: string;
    kycStatus: 'NONE' | 'PENDING' | 'VERIFIED' | 'REJECTED';
    panLast4: string;
    blocked: boolean;
    anonymizedAt: Date;
    subscriptions: Array<{
      tier: 'PRO' | 'PRO_MAX';
      status: 'ACTIVE' | 'CANCELLED' | 'EXPIRED';
      expiresAt?: Date;
    }>;
  }> = {},
): Promise<{ userId: Types.ObjectId }> {
  const userId = new Types.ObjectId();
  await UserModel.create({
    _id: userId,
    phone: overrides.phone ?? `+9198${Math.floor(Math.random() * 100_000_000)}`,
    dob: new Date('1995-01-01'),
    declaredState: 'IN-MH',
    coinBalance: 3,
    ...(overrides.displayName ? { displayName: overrides.displayName } : {}),
    ...(overrides.avatarUrl ? { avatarUrl: overrides.avatarUrl } : {}),
    kyc: {
      status: overrides.kycStatus ?? 'NONE',
      ...(overrides.panLast4 ? { panLast4: overrides.panLast4 } : {}),
    },
    blocked: { isBlocked: overrides.blocked ?? false },
    ...(overrides.anonymizedAt ? { anonymizedAt: overrides.anonymizedAt } : {}),
    ...(overrides.subscriptions ? { subscriptions: overrides.subscriptions } : {}),
  });
  return { userId };
}

describe('UserProfileService.getMe — Phase 11.5 shape', () => {
  it('empty subscriptions[] → response carries subscriptions:[] and currentTier:PUBLIC', async () => {
    const { userId } = await seedUser({ phone: '+919876543210' });
    const svc = new UserProfileService({ clock: () => NOW });
    const profile = await svc.getMe(userId);

    expect(profile.id).toBe(userId.toHexString());
    expect(profile.phone).toBe('+919876543210');
    expect(profile.subscriptions).toEqual([]);
    expect(profile.currentTier).toBe('PUBLIC');
    // Legacy fields gone:
    expect(profile).not.toHaveProperty('tier');
    expect(profile).not.toHaveProperty('subscription');
  });

  it('single PRO ACTIVE → subscriptions has 1 entry, currentTier=PRO', async () => {
    const { userId } = await seedUser({
      subscriptions: [{ tier: 'PRO', status: 'ACTIVE', expiresAt: FUTURE }],
    });
    const svc = new UserProfileService({ clock: () => NOW });
    const profile = await svc.getMe(userId);

    expect(profile.subscriptions).toHaveLength(1);
    expect(profile.subscriptions[0]).toEqual({
      tier: 'PRO',
      status: 'ACTIVE',
      expiresAt: FUTURE.toISOString(),
    });
    expect(profile.currentTier).toBe('PRO');
  });

  it('PRO + PRO_MAX both ACTIVE → 2 entries, currentTier=PRO_MAX (highest active)', async () => {
    const { userId } = await seedUser({
      subscriptions: [
        { tier: 'PRO', status: 'ACTIVE', expiresAt: FUTURE },
        { tier: 'PRO_MAX', status: 'ACTIVE', expiresAt: FUTURE },
      ],
    });
    const svc = new UserProfileService({ clock: () => NOW });
    const profile = await svc.getMe(userId);

    expect(profile.subscriptions).toHaveLength(2);
    expect(profile.currentTier).toBe('PRO_MAX');
  });

  it('PRO_MAX-only subscription → currentTier=PRO_MAX (no hierarchy collapse)', async () => {
    const { userId } = await seedUser({
      subscriptions: [{ tier: 'PRO_MAX', status: 'ACTIVE', expiresAt: FUTURE }],
    });
    const svc = new UserProfileService({ clock: () => NOW });
    const profile = await svc.getMe(userId);

    expect(profile.subscriptions).toHaveLength(1);
    expect(profile.subscriptions[0]?.tier).toBe('PRO_MAX');
    expect(profile.currentTier).toBe('PRO_MAX');
  });

  it('CANCELLED-in-grace counts as active → currentTier reflects grace tier', async () => {
    const { userId } = await seedUser({
      subscriptions: [{ tier: 'PRO', status: 'CANCELLED', expiresAt: FUTURE }],
    });
    const svc = new UserProfileService({ clock: () => NOW });
    const profile = await svc.getMe(userId);

    expect(profile.currentTier).toBe('PRO');
  });

  it('CANCELLED-expired entry → still appears in subscriptions[] but currentTier=PUBLIC', async () => {
    // Sweep should have removed it; defense-in-depth that derivation
    // doesn't count it.
    const { userId } = await seedUser({
      subscriptions: [{ tier: 'PRO', status: 'CANCELLED', expiresAt: PAST }],
    });
    const svc = new UserProfileService({ clock: () => NOW });
    const profile = await svc.getMe(userId);

    expect(profile.subscriptions).toHaveLength(1);
    expect(profile.currentTier).toBe('PUBLIC');
  });

  it('panLast4 surfaced only when kyc.status === VERIFIED', async () => {
    const verified = await seedUser({ kycStatus: 'VERIFIED', panLast4: '1234' });
    const pending = await seedUser({ kycStatus: 'PENDING', panLast4: '8888' });
    const none = await seedUser({ kycStatus: 'NONE' });

    const svc = new UserProfileService({ clock: () => NOW });
    expect((await svc.getMe(verified.userId)).kyc.panLast4).toBe('1234');
    expect((await svc.getMe(pending.userId)).kyc.panLast4).toBeUndefined();
    expect((await svc.getMe(none.userId)).kyc.panLast4).toBeUndefined();
  });

  it('throws 404 when anonymizedAt is set, 403 when blocked', async () => {
    const a = await seedUser({ anonymizedAt: new Date() });
    const svc = new UserProfileService({ clock: () => NOW });
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

  it('privacy: returned DTO does NOT carry internal fields (dob, declaredState, PAN ciphertext, __v)', async () => {
    const { userId } = await seedUser({ kycStatus: 'VERIFIED', panLast4: '1234' });
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

    const svc = new UserProfileService({ clock: () => NOW });
    const profile = await svc.getMe(userId);

    expect(profile).not.toHaveProperty('dob');
    expect(profile).not.toHaveProperty('declaredState');
    expect(profile).not.toHaveProperty('email');
    expect(profile).not.toHaveProperty('referralCode');
    expect(profile).not.toHaveProperty('blocked');
    expect(profile).not.toHaveProperty('anonymizedAt');
    expect(profile).not.toHaveProperty('__v');
    expect(profile.kyc).not.toHaveProperty('panCt');
    expect(profile.kyc).not.toHaveProperty('panIv');
    expect(profile.kyc).not.toHaveProperty('panTag');
    expect(profile.kyc).not.toHaveProperty('panDekEnc');
  });
});
