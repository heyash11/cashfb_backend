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

async function seedBaseRate(baseRatePerVote: number): Promise<void> {
  await AppConfigModel.updateOne(
    { key: 'default' },
    { $set: { baseRatePerVote } },
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
    expect(first).toEqual({
      created: true,
      yesterdayVoteCount: 100,
      baseRatePaise: 100,
      totalPoolPaise: 10_000, // 100 × 100
      giftCodeBudgetPaise: 7_000, // 0.7 × 10000
      customRoomBudgetPaise: 3_000,
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
});
