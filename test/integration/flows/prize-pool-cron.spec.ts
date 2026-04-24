import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import { createPrizePoolHandler } from '../../../src/workers/prize-pool.worker.js';
import { AppConfigModel } from '../../../src/shared/models/AppConfig.model.js';
import { PrizePoolModel } from '../../../src/shared/models/PrizePool.model.js';
import { VoteModel } from '../../../src/shared/models/Vote.model.js';
import { connectHarness, disconnectHarness, resetFullState } from './_harness.js';

/**
 * Integration — prize-pool daily cron handler against real Mongo.
 * Seeds yesterday's votes, invokes the handler directly (bypasses
 * BullMQ), asserts the PrizePool row materialises with the correct
 * math.
 *
 * Regression guard for the Phase 6 Pattern-1 idempotency: two
 * concurrent handler invocations produce exactly ONE prize_pools
 * row (unique index on dayKey) and the second returns created:false
 * with the winner's values.
 */
beforeAll(async () => {
  await connectHarness();
}, 30_000);

afterAll(async () => {
  await disconnectHarness();
});

beforeEach(async () => {
  await resetFullState();
});

describe('[integration] prize-pool cron handler', () => {
  it('materialises PrizePool row from yesterday votes with correct 70/30 split', async () => {
    const yesterdayDayKey = '2026-04-23';
    // Seed 10 votes for yesterday — each funds the pool at
    // baseRatePerVote paise.
    const voteRows = Array.from({ length: 10 }, (_, i) => ({
      userId: new Types.ObjectId(),
      dayKey: yesterdayDayKey,
      target: `target-${i}`,
      coinsSpent: 3,
    }));
    await VoteModel.insertMany(voteRows);

    await AppConfigModel.updateOne(
      { key: 'default' },
      { $set: { baseRatePerVote: 100 } },
      { upsert: true },
    );

    const handler = createPrizePoolHandler();
    const scheduledFor = '2026-04-24T00:00:00+05:30'; // IST midnight

    const result1 = await handler({ scheduledFor });
    expect(result1.created).toBe(true);
    expect(result1.yesterdayVoteCount).toBe(10);
    expect(result1.totalPoolPaise).toBe(1000); // 10 × 100
    expect(result1.giftCodeBudgetPaise).toBe(700); // 70% of 1000
    expect(result1.customRoomBudgetPaise).toBe(300);

    const row = await PrizePoolModel.findOne({ dayKey: '2026-04-24' });
    expect(row).toBeTruthy();
    expect(row?.totalPool).toBe(1000);

    // Second invocation with same scheduledFor must be idempotent.
    const result2 = await handler({ scheduledFor });
    expect(result2.created).toBe(false);
    expect(result2.totalPoolPaise).toBe(1000);

    // Still exactly one row.
    expect(await PrizePoolModel.countDocuments({ dayKey: '2026-04-24' })).toBe(1);
  });
});
