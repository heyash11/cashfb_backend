import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  clearAllCollections,
  connectTestMongo,
  disconnectTestMongo,
} from '../../../test/testing/mongo.js';
import { PrizePoolModel } from '../../shared/models/PrizePool.model.js';
import { runBackfillPrizePoolTier } from './backfill-prize-pool-tier.js';

beforeAll(async () => {
  await connectTestMongo();
}, 30_000);

afterAll(async () => {
  await disconnectTestMongo();
});

beforeEach(async () => {
  await clearAllCollections();
});

describe('runBackfillPrizePoolTier', () => {
  it('empty collection — no-op', async () => {
    const report = await runBackfillPrizePoolTier();
    expect(report).toEqual({ collection: 'prize_pools', scanned: 0, updated: 0, skipped: 0 });
  });

  it("legacy pools (no tier field) all become tier='PUBLIC'", async () => {
    await PrizePoolModel.collection.insertMany([
      { dayKey: '2026-04-25', yesterdayVoteCount: 5, baseRate: 100, totalPool: 500 },
      { dayKey: '2026-04-26', yesterdayVoteCount: 7, baseRate: 100, totalPool: 700 },
    ]);

    const report = await runBackfillPrizePoolTier();
    expect(report.scanned).toBe(2);
    expect(report.updated).toBe(2);
    expect(await PrizePoolModel.countDocuments({ tier: 'PUBLIC' })).toBe(2);
  });

  it('idempotent re-run', async () => {
    await PrizePoolModel.collection.insertMany([
      { dayKey: '2026-04-25', yesterdayVoteCount: 5, baseRate: 100, totalPool: 500 },
    ]);
    await runBackfillPrizePoolTier();
    const second = await runBackfillPrizePoolTier();
    expect(second.updated).toBe(0);
  });
});
