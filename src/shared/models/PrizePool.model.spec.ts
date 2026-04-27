import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  clearAllCollections,
  connectTestMongo,
  disconnectTestMongo,
} from '../../../test/testing/mongo.js';
import { PrizePoolModel } from './PrizePool.model.js';

/**
 * Phase 11.0 — schema-level coverage for `PrizePool.tier` and the
 * compound unique index `{tier, dayKey}` that replaces the
 * pre-migration `{dayKey}` unique.
 */
beforeAll(async () => {
  await connectTestMongo();
  await PrizePoolModel.syncIndexes();
}, 30_000);

afterAll(async () => {
  await disconnectTestMongo();
});

beforeEach(async () => {
  await clearAllCollections();
});

describe('PrizePool model — Phase 11.0 tier additions', () => {
  it("`tier` defaults to 'PUBLIC' when omitted on insert", async () => {
    const row = await PrizePoolModel.create({
      dayKey: '2026-04-27',
      yesterdayVoteCount: 10,
      baseRate: 100,
      totalPool: 1000,
    });
    expect(row.tier).toBe('PUBLIC');
  });

  it('compound unique permits three rows per dayKey (one per tier)', async () => {
    for (const tier of ['PUBLIC', 'PRO', 'PRO_MAX'] as const) {
      await PrizePoolModel.create({
        tier,
        dayKey: '2026-04-27',
        yesterdayVoteCount: 5,
        baseRate: 100,
        totalPool: 500,
      });
    }
    expect(await PrizePoolModel.countDocuments({ dayKey: '2026-04-27' })).toBe(3);
  });

  it('compound unique BLOCKS duplicate (tier, dayKey)', async () => {
    await PrizePoolModel.create({
      tier: 'PUBLIC',
      dayKey: '2026-04-27',
      yesterdayVoteCount: 5,
      baseRate: 100,
      totalPool: 500,
    });
    await expect(
      PrizePoolModel.create({
        tier: 'PUBLIC',
        dayKey: '2026-04-27',
        yesterdayVoteCount: 6,
        baseRate: 100,
        totalPool: 600,
      }),
    ).rejects.toMatchObject({ code: 11000 });
  });

  it('legacy {dayKey} unique index is not present after syncIndexes', async () => {
    const indexes = await PrizePoolModel.collection.getIndexes();
    const indexNames = Object.keys(indexes);
    expect(indexNames).toContain('tier_1_dayKey_1');
    expect(indexNames).not.toContain('dayKey_1');
  });
});
