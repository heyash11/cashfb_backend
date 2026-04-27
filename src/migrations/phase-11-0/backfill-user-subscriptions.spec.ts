import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  clearAllCollections,
  connectTestMongo,
  disconnectTestMongo,
} from '../../../test/testing/mongo.js';
import { SubscriptionModel } from '../../shared/models/Subscription.model.js';
import { UserModel } from '../../shared/models/User.model.js';
import {
  mapSubscriptionStatusForBackfill,
  runBackfillUserSubscriptions,
} from './backfill-user-subscriptions.js';

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

async function seedUser(opts: {
  phone: string;
  tier?: 'PUBLIC' | 'PRO' | 'PRO_MAX';
  activeSubscriptionId?: Types.ObjectId;
  tierExpiresAt?: Date;
}): Promise<Types.ObjectId> {
  const userId = new Types.ObjectId();
  await UserModel.create({
    _id: userId,
    phone: opts.phone,
    dob: new Date('1995-01-01'),
    declaredState: 'IN-MH',
    tier: opts.tier ?? 'PUBLIC',
    kyc: { status: 'NONE' },
    blocked: { isBlocked: false },
    ...(opts.activeSubscriptionId ? { activeSubscriptionId: opts.activeSubscriptionId } : {}),
    ...(opts.tierExpiresAt ? { tierExpiresAt: opts.tierExpiresAt } : {}),
  });
  return userId;
}

async function seedSub(
  userId: Types.ObjectId,
  tier: 'PRO' | 'PRO_MAX',
  status:
    | 'CREATED'
    | 'AUTHENTICATED'
    | 'ACTIVE'
    | 'PENDING'
    | 'HALTED'
    | 'CANCELLED'
    | 'COMPLETED'
    | 'PAUSED',
): Promise<Types.ObjectId> {
  const sub = await SubscriptionModel.create({
    userId,
    tier,
    razorpaySubscriptionId: `sub_${userId.toHexString()}`,
    razorpayPlanId: 'plan_test',
    status,
  });
  return sub._id;
}

describe('mapSubscriptionStatusForBackfill', () => {
  it("ACTIVE → 'ACTIVE'", () => {
    expect(mapSubscriptionStatusForBackfill('ACTIVE', undefined, NOW)).toBe('ACTIVE');
  });
  it("CANCELLED + future tierExpiresAt → 'ACTIVE' (grace)", () => {
    expect(mapSubscriptionStatusForBackfill('CANCELLED', FUTURE, NOW)).toBe('ACTIVE');
  });
  it("CANCELLED + past tierExpiresAt → 'CANCELLED'", () => {
    expect(mapSubscriptionStatusForBackfill('CANCELLED', PAST, NOW)).toBe('CANCELLED');
  });
  it("HALTED + PAUSED → 'CANCELLED'", () => {
    expect(mapSubscriptionStatusForBackfill('HALTED', undefined, NOW)).toBe('CANCELLED');
    expect(mapSubscriptionStatusForBackfill('PAUSED', undefined, NOW)).toBe('CANCELLED');
  });
  it("COMPLETED → 'EXPIRED'", () => {
    expect(mapSubscriptionStatusForBackfill('COMPLETED', undefined, NOW)).toBe('EXPIRED');
  });
  it('CREATED / AUTHENTICATED / PENDING → undefined (omit entirely)', () => {
    expect(mapSubscriptionStatusForBackfill('CREATED', undefined, NOW)).toBeUndefined();
    expect(mapSubscriptionStatusForBackfill('AUTHENTICATED', undefined, NOW)).toBeUndefined();
    expect(mapSubscriptionStatusForBackfill('PENDING', undefined, NOW)).toBeUndefined();
  });
});

describe('runBackfillUserSubscriptions', () => {
  it('empty users — no-op, no anomalies', async () => {
    const report = await runBackfillUserSubscriptions(() => NOW);
    expect(report.scanned).toBe(0);
    expect(report.anomalyCount).toBe(0);
  });

  it('PUBLIC users are not scanned and stay with subscriptions=[]', async () => {
    await seedUser({ phone: '+919800000001', tier: 'PUBLIC' });
    const report = await runBackfillUserSubscriptions(() => NOW);
    expect(report.scanned).toBe(0);
    const user = await UserModel.findOne({ phone: '+919800000001' }).lean();
    expect(user?.subscriptions ?? []).toEqual([]);
  });

  it('happy path — PRO + ACTIVE sub gets translated into one entry', async () => {
    const userId = await seedUser({ phone: '+919800000002', tier: 'PRO', tierExpiresAt: FUTURE });
    const subId = await seedSub(userId, 'PRO', 'ACTIVE');
    await UserModel.updateOne({ _id: userId }, { $set: { activeSubscriptionId: subId } });

    const report = await runBackfillUserSubscriptions(() => NOW);
    expect(report.updated).toBe(1);
    expect(report.anomalyCount).toBe(0);

    const user = await UserModel.findById(userId).lean();
    expect(user?.subscriptions).toHaveLength(1);
    expect(user?.subscriptions[0]).toMatchObject({
      tier: 'PRO',
      status: 'ACTIVE',
      subscriptionId: subId,
      expiresAt: FUTURE,
    });
  });

  it("CANCELLED + grace → stored as 'ACTIVE'; CANCELLED + past → 'CANCELLED'", async () => {
    const u1 = await seedUser({ phone: '+919800000003', tier: 'PRO', tierExpiresAt: FUTURE });
    const s1 = await seedSub(u1, 'PRO', 'CANCELLED');
    await UserModel.updateOne({ _id: u1 }, { $set: { activeSubscriptionId: s1 } });

    const u2 = await seedUser({ phone: '+919800000004', tier: 'PRO', tierExpiresAt: PAST });
    const s2 = await seedSub(u2, 'PRO', 'CANCELLED');
    await UserModel.updateOne({ _id: u2 }, { $set: { activeSubscriptionId: s2 } });

    await runBackfillUserSubscriptions(() => NOW);

    const grace = await UserModel.findById(u1).lean();
    expect(grace?.subscriptions[0]?.status).toBe('ACTIVE');

    const expired = await UserModel.findById(u2).lean();
    expect(expired?.subscriptions[0]?.status).toBe('CANCELLED');
  });

  it('PENDING-state subscription is omitted (no entry pushed) — matches /me posture', async () => {
    const userId = await seedUser({ phone: '+919800000005', tier: 'PRO' });
    const subId = await seedSub(userId, 'PRO', 'PENDING');
    await UserModel.updateOne({ _id: userId }, { $set: { activeSubscriptionId: subId } });

    const report = await runBackfillUserSubscriptions(() => NOW);
    expect(report.updated).toBe(0);
    expect(report.skipped).toBe(1);

    const user = await UserModel.findById(userId).lean();
    expect(user?.subscriptions ?? []).toEqual([]);
  });

  it('§R4 anomaly — tier!=PUBLIC but no activeSubscriptionId → logged + skipped', async () => {
    const u1 = await seedUser({ phone: '+919800000006', tier: 'PRO' });

    const report = await runBackfillUserSubscriptions(() => NOW);
    expect(report.scanned).toBe(1);
    expect(report.updated).toBe(0);
    expect(report.anomalyCount).toBe(1);
    expect(report.anomalyUsers).toEqual([String(u1)]);

    const user = await UserModel.findById(u1).lean();
    expect(user?.subscriptions ?? []).toEqual([]);
    // Backfill never touches legacy fields per §A4.
    expect(user?.tier).toBe('PRO');
  });

  it('anomaly path — activeSubscriptionId set but Subscription doc missing → skipped + logged', async () => {
    const ghostSubId = new Types.ObjectId();
    const userId = await seedUser({
      phone: '+919800000007',
      tier: 'PRO',
      activeSubscriptionId: ghostSubId,
    });

    const report = await runBackfillUserSubscriptions(() => NOW);
    expect(report.anomalyCount).toBe(1);
    expect(report.anomalyUsers).toEqual([String(userId)]);
  });

  it('idempotent — re-run skips users whose subscriptions[] already contains the tier entry', async () => {
    const userId = await seedUser({ phone: '+919800000008', tier: 'PRO', tierExpiresAt: FUTURE });
    const subId = await seedSub(userId, 'PRO', 'ACTIVE');
    await UserModel.updateOne({ _id: userId }, { $set: { activeSubscriptionId: subId } });

    await runBackfillUserSubscriptions(() => NOW);
    const second = await runBackfillUserSubscriptions(() => NOW);
    expect(second.updated).toBe(0);
    expect(second.skipped).toBe(1);

    const user = await UserModel.findById(userId).lean();
    expect(user?.subscriptions).toHaveLength(1);
  });
});
