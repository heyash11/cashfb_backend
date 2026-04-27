import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  clearAllCollections,
  connectTestMongo,
  disconnectTestMongo,
} from '../../../test/testing/mongo.js';
import { AppConfigModel } from '../../shared/models/AppConfig.model.js';
import { MODELS } from '../../shared/models/index.js';
import { PrizePoolModel } from '../../shared/models/PrizePool.model.js';
import { UserModel } from '../../shared/models/User.model.js';
import { VoteModel } from '../../shared/models/Vote.model.js';
import { PrizePoolService } from './prize-pools.service.js';

type AnyModel = { syncIndexes(): Promise<string[]> };

async function seedVotes(dayKey: string, count: number): Promise<void> {
  const docs = Array.from({ length: count }, (_, i) => ({
    userId: new Types.ObjectId(),
    dayKey,
    target: `creator-${i}`,
    coinsSpent: 3,
  }));
  await VoteModel.insertMany(docs);
}

const TIER_PHONE_PREFIX: Record<'PUBLIC' | 'PRO' | 'PRO_MAX', string> = {
  PUBLIC: '+9198000010',
  PRO: '+9198000020',
  PRO_MAX: '+9198000030',
};

async function seedTieredVoter(
  dayKey: string,
  tier: 'PUBLIC' | 'PRO' | 'PRO_MAX',
  index: number,
): Promise<void> {
  const userId = new Types.ObjectId();
  await UserModel.create({
    _id: userId,
    phone: `${TIER_PHONE_PREFIX[tier]}${String(index).padStart(3, '0')}`,
    dob: new Date('1995-01-01'),
    declaredState: 'IN-MH',
    tier,
    coinBalance: 0,
    kyc: { status: 'NONE' },
    blocked: { isBlocked: false },
  });
  await VoteModel.create({
    userId,
    dayKey,
    target: `creator-${tier}-${index}`,
    coinsSpent: 3,
  });
}

async function seedBaseRate(baseRatePerVote: number): Promise<void> {
  await AppConfigModel.updateOne(
    { key: 'default' },
    { $set: { baseRatePerVote } },
    { upsert: true },
  );
}

async function seedMultipliers(proMultiplier: number, proMaxMultiplier: number): Promise<void> {
  await AppConfigModel.updateOne(
    { key: 'default' },
    { $set: { proMultiplier, proMaxMultiplier } },
    { upsert: true },
  );
}

beforeAll(async () => {
  await connectTestMongo();
  await Promise.all(Object.values(MODELS).map((m) => (m as unknown as AnyModel).syncIndexes()));
}, 120_000);

afterAll(async () => {
  await disconnectTestMongo();
});

beforeEach(async () => {
  await clearAllCollections();
});

describe('PrizePoolService.computeAndPublishPool', () => {
  it('writes exactly one prize_pools row per dayKey with correct math; re-invocation returns {created: false} with matching values', async () => {
    const svc = new PrizePoolService({ clock: () => new Date('2026-04-24T00:00:00Z') });
    // Default baseRatePerVote = 100 paise (AppConfig schema default).
    await seedBaseRate(100);
    await seedVotes('2026-04-23', 100);

    const first = await svc.computeAndPublishPool({
      dayKey: '2026-04-24',
      yesterdayDayKey: '2026-04-23',
    });
    // Votes seeded without User rows fall back to PUBLIC tier in the
    // aggregation (Phase 10.1 §A2 — missing-user fallback).
    expect(first).toEqual({
      created: true,
      yesterdayVoteCount: 100,
      weightedVoteUnits: 100, // 100 PUBLIC × 1
      baseRatePaise: 100,
      totalPoolPaise: 10_000, // 100 × 100
      giftCodeBudgetPaise: 7_000, // 0.7 × 10000
      customRoomBudgetPaise: 3_000,
      tierBreakdown: { public: 100, pro: 0, proMax: 0 },
    });

    const rows = await PrizePoolModel.find({ dayKey: '2026-04-24' });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('CALCULATED');
    expect(rows[0]?.totalPool).toBe(10_000);
    expect(rows[0]?.giftCodeBudget).toBe(7_000);
    expect(rows[0]?.customRoomBudget).toBe(3_000);
    expect(rows[0]?.calculatedAt).toBeInstanceOf(Date);

    // Re-invocation is a no-op; matches prior values verbatim.
    const second = await svc.computeAndPublishPool({
      dayKey: '2026-04-24',
      yesterdayDayKey: '2026-04-23',
    });
    expect(second.created).toBe(false);
    expect(second.totalPoolPaise).toBe(10_000);
    expect(second.giftCodeBudgetPaise).toBe(7_000);
    expect(second.customRoomBudgetPaise).toBe(3_000);
    expect(second.baseRatePaise).toBe(100);
    expect(second.yesterdayVoteCount).toBe(100);

    // Still exactly one row.
    expect(await PrizePoolModel.countDocuments({ dayKey: '2026-04-24' })).toBe(1);
  });

  it('reads baseRatePerVote from AppConfig at compute time: 200 paise doubles the pool', async () => {
    const svc = new PrizePoolService();
    await seedBaseRate(200);
    await seedVotes('2026-04-23', 50);

    const res = await svc.computeAndPublishPool({
      dayKey: '2026-04-24',
      yesterdayDayKey: '2026-04-23',
    });

    expect(res.baseRatePaise).toBe(200);
    expect(res.totalPoolPaise).toBe(10_000); // 50 × 200 = doubled vs. 50 × 100
    expect(res.giftCodeBudgetPaise).toBe(7_000);
    expect(res.customRoomBudgetPaise).toBe(3_000);
  });

  it('zero votes yesterday: pool row written with totalPool=0, budgets=0, status CALCULATED', async () => {
    const svc = new PrizePoolService();
    await seedBaseRate(100);
    // No votes seeded for '2026-04-23'.

    const res = await svc.computeAndPublishPool({
      dayKey: '2026-04-24',
      yesterdayDayKey: '2026-04-23',
    });

    expect(res).toMatchObject({
      created: true,
      yesterdayVoteCount: 0,
      totalPoolPaise: 0,
      giftCodeBudgetPaise: 0,
      customRoomBudgetPaise: 0,
    });

    const row = await PrizePoolModel.findOne({ dayKey: '2026-04-24' });
    expect(row).toBeTruthy();
    expect(row?.totalPool).toBe(0);
    expect(row?.status).toBe('CALCULATED');
  });

  it('odd-paisa split: 1001-paise total → giftCode=700 + customRoom=301, components re-sum to total', async () => {
    const svc = new PrizePoolService();
    // baseRate × votes = 1001 (odd). 143 × 7 = 1001.
    await seedBaseRate(143);
    await seedVotes('2026-04-23', 7);

    const res = await svc.computeAndPublishPool({
      dayKey: '2026-04-24',
      yesterdayDayKey: '2026-04-23',
    });

    expect(res.totalPoolPaise).toBe(1001);
    expect(res.giftCodeBudgetPaise).toBe(700); // floor(0.7 × 1001) = 700
    expect(res.customRoomBudgetPaise).toBe(301); // 1001 − 700
    expect(res.giftCodeBudgetPaise + res.customRoomBudgetPaise).toBe(res.totalPoolPaise);
  });

  // Phase 10.1 §PD5 — tier-weighted aggregation.
  it('mixed-tier voters: PUBLIC×1 + PRO×5 + PRO_MAX×10 (default multipliers)', async () => {
    const svc = new PrizePoolService();
    await seedBaseRate(100);
    // Defaults from AppConfig schema: proMultiplier=5, proMaxMultiplier=10.
    // Don't seed multipliers — exercise default fallback path.

    // 4 PUBLIC + 2 PRO + 1 PRO_MAX → weightedUnits = 4 + 10 + 10 = 24.
    for (let i = 0; i < 4; i++) await seedTieredVoter('2026-04-23', 'PUBLIC', i);
    for (let i = 0; i < 2; i++) await seedTieredVoter('2026-04-23', 'PRO', i);
    await seedTieredVoter('2026-04-23', 'PRO_MAX', 0);

    const res = await svc.computeAndPublishPool({
      dayKey: '2026-04-24',
      yesterdayDayKey: '2026-04-23',
    });

    expect(res.yesterdayVoteCount).toBe(7); // raw rows
    expect(res.weightedVoteUnits).toBe(24); // 4 + 2×5 + 1×10
    expect(res.totalPoolPaise).toBe(2400); // 24 × 100
    expect(res.giftCodeBudgetPaise).toBe(1680); // floor(0.7 × 2400)
    expect(res.customRoomBudgetPaise).toBe(720);
    expect(res.tierBreakdown).toEqual({ public: 4, pro: 2, proMax: 1 });

    const row = await PrizePoolModel.findOne({ dayKey: '2026-04-24' });
    expect(row?.proMultiplier).toBe(5);
    expect(row?.proMaxMultiplier).toBe(10);
    expect(row?.totalPool).toBe(2400);
  });

  // Phase 10.1 §A3 — admin-tunable multipliers reach the math.
  it('respects custom multipliers from AppConfig (proMultiplier=3, proMaxMultiplier=7)', async () => {
    const svc = new PrizePoolService();
    await seedBaseRate(100);
    await seedMultipliers(3, 7);

    // 1 PUBLIC + 1 PRO + 1 PRO_MAX → weightedUnits = 1 + 3 + 7 = 11.
    await seedTieredVoter('2026-04-23', 'PUBLIC', 0);
    await seedTieredVoter('2026-04-23', 'PRO', 0);
    await seedTieredVoter('2026-04-23', 'PRO_MAX', 0);

    const res = await svc.computeAndPublishPool({
      dayKey: '2026-04-24',
      yesterdayDayKey: '2026-04-23',
    });

    expect(res.yesterdayVoteCount).toBe(3);
    expect(res.weightedVoteUnits).toBe(11);
    expect(res.totalPoolPaise).toBe(1100);

    const row = await PrizePoolModel.findOne({ dayKey: '2026-04-24' });
    // The row records the multipliers actually used so historical
    // pool rows remain auditable even if AppConfig changes.
    expect(row?.proMultiplier).toBe(3);
    expect(row?.proMaxMultiplier).toBe(7);
  });

  // Phase 10.1 §A2 — missing-user fallback.
  it('treats votes whose User row is missing as PUBLIC weight (DPDP-anonymized voters keep funding the pool)', async () => {
    const svc = new PrizePoolService();
    await seedBaseRate(100);

    // 2 votes from real PRO voters + 3 votes with dangling userIds.
    await seedTieredVoter('2026-04-23', 'PRO', 0);
    await seedTieredVoter('2026-04-23', 'PRO', 1);
    await seedVotes('2026-04-23', 3); // userIds reference non-existent rows

    const res = await svc.computeAndPublishPool({
      dayKey: '2026-04-24',
      yesterdayDayKey: '2026-04-23',
    });

    expect(res.yesterdayVoteCount).toBe(5);
    // 2 PRO × 5 + 3 PUBLIC-fallback × 1 = 13 weighted units.
    expect(res.weightedVoteUnits).toBe(13);
    expect(res.totalPoolPaise).toBe(1300);
    expect(res.tierBreakdown).toEqual({ public: 3, pro: 2, proMax: 0 });
  });

  // Phase 10.1 §A1 — live-lookup posture verification.
  it('uses LIVE user.tier at compute time (downgrade-before-midnight loses the multiplier)', async () => {
    const svc = new PrizePoolService();
    await seedBaseRate(100);

    // Voter casts vote, then downgrades from PRO to PUBLIC before
    // midnight cron. Because we live-lookup tier, the vote counts
    // at PUBLIC weight on the next day's pool.
    const userId = new Types.ObjectId();
    await UserModel.create({
      _id: userId,
      phone: '+919800000001',
      dob: new Date('1995-01-01'),
      declaredState: 'IN-MH',
      tier: 'PRO', // initial state when vote was cast
      coinBalance: 0,
      kyc: { status: 'NONE' },
      blocked: { isBlocked: false },
    });
    await VoteModel.create({
      userId,
      dayKey: '2026-04-23',
      target: 'creator-x',
      coinsSpent: 3,
    });
    // Tier-expiry sweep ran before our cron → user is now PUBLIC.
    await UserModel.updateOne({ _id: userId }, { $set: { tier: 'PUBLIC' } });

    const res = await svc.computeAndPublishPool({
      dayKey: '2026-04-24',
      yesterdayDayKey: '2026-04-23',
    });

    expect(res.yesterdayVoteCount).toBe(1);
    expect(res.weightedVoteUnits).toBe(1); // PUBLIC × 1, not PRO × 5
    expect(res.tierBreakdown).toEqual({ public: 1, pro: 0, proMax: 0 });
  });
});
