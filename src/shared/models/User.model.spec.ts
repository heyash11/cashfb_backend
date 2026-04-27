import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  clearAllCollections,
  connectTestMongo,
  disconnectTestMongo,
} from '../../../test/testing/mongo.js';
import { UserModel } from './User.model.js';

/**
 * Phase 11.0 — schema-level coverage for `User.subscriptions[]`
 * and the multi-key index `{'subscriptions.tier','subscriptions.expiresAt'}`.
 */
beforeAll(async () => {
  await connectTestMongo();
  await UserModel.syncIndexes();
}, 30_000);

afterAll(async () => {
  await disconnectTestMongo();
});

beforeEach(async () => {
  await clearAllCollections();
});

const baseUser = {
  dob: new Date('1995-01-01'),
  declaredState: 'IN-MH',
  kyc: { status: 'NONE' as const },
  blocked: { isBlocked: false },
};

describe('User model — Phase 11.0 subscriptions[] additions', () => {
  it('`subscriptions` defaults to [] on a freshly-inserted user', async () => {
    const user = await UserModel.create({ ...baseUser, phone: '+919800000001' });
    expect(user.subscriptions).toEqual([]);
  });

  it('accepts multiple parallel subscription entries (PRO + PRO_MAX)', async () => {
    const user = await UserModel.create({
      ...baseUser,
      phone: '+919800000002',
      subscriptions: [
        { tier: 'PRO', status: 'ACTIVE', expiresAt: new Date('2027-01-01') },
        { tier: 'PRO_MAX', status: 'ACTIVE', expiresAt: new Date('2027-01-15') },
      ],
    });
    expect(user.subscriptions).toHaveLength(2);
    expect(user.subscriptions.map((s) => s.tier).sort()).toEqual(['PRO', 'PRO_MAX']);
  });

  it("rejects a 'PUBLIC' subscription entry (PUBLIC = empty array, never an entry)", async () => {
    await expect(
      UserModel.create({
        ...baseUser,
        phone: '+919800000003',
        subscriptions: [{ tier: 'PUBLIC' as 'PRO', status: 'ACTIVE' }],
      }),
    ).rejects.toMatchObject({ name: 'ValidationError' });
  });

  it('rejects an invalid status on a subscription entry', async () => {
    await expect(
      UserModel.create({
        ...baseUser,
        phone: '+919800000004',
        subscriptions: [{ tier: 'PRO', status: 'PAUSED' as 'ACTIVE' }],
      }),
    ).rejects.toMatchObject({ name: 'ValidationError' });
  });

  it('subscription entries do NOT carry their own _id (subdoc _id: false)', async () => {
    const user = await UserModel.create({
      ...baseUser,
      phone: '+919800000005',
      subscriptions: [{ tier: 'PRO', status: 'ACTIVE' }],
    });
    const stored = (user.subscriptions[0] ?? {}) as Record<string, unknown>;
    expect(stored).not.toHaveProperty('_id');
  });

  it('multi-key index {subscriptions.tier, subscriptions.expiresAt} exists', async () => {
    const indexes = await UserModel.collection.getIndexes();
    const indexNames = Object.keys(indexes);
    expect(indexNames).toContain('subscriptions.tier_1_subscriptions.expiresAt_1');
  });

  it('legacy `tier` field still defaults to PUBLIC and coexists with subscriptions[]', async () => {
    const user = await UserModel.create({ ...baseUser, phone: '+919800000006' });
    expect(user.tier).toBe('PUBLIC');
    expect(user.subscriptions).toEqual([]);
    // The two are independent until Phase 11.5 reconciles them.
    expect(user.activeSubscriptionId).toBeUndefined();
  });

  it('subscription entries can include a subscriptionId pointer for audit', async () => {
    const subId = new Types.ObjectId();
    const user = await UserModel.create({
      ...baseUser,
      phone: '+919800000007',
      subscriptions: [{ tier: 'PRO', status: 'ACTIVE', subscriptionId: subId }],
    });
    const entry = user.subscriptions[0];
    expect(entry).toBeDefined();
    expect(String(entry?.subscriptionId)).toBe(String(subId));
  });
});
