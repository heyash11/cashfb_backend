import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  clearAllCollections,
  connectTestMongo,
  disconnectTestMongo,
} from '../../../test/testing/mongo.js';
import { VoteModel } from './Vote.model.js';

/**
 * Phase 11.0 — schema-level coverage for `Vote.tier` and the
 * compound unique index `{userId, tier, dayKey}`.
 */
beforeAll(async () => {
  await connectTestMongo();
  await VoteModel.syncIndexes();
}, 30_000);

afterAll(async () => {
  await disconnectTestMongo();
});

beforeEach(async () => {
  await clearAllCollections();
});

describe('Vote model — Phase 11.0 tier additions', () => {
  it("`tier` defaults to 'PUBLIC' when omitted on insert", async () => {
    const userId = new Types.ObjectId();
    const v = await VoteModel.create({
      userId,
      dayKey: '2026-04-27',
      target: 'creator-x',
    });
    expect(v.tier).toBe('PUBLIC');
  });

  it('rejects an invalid `tier` value', async () => {
    const userId = new Types.ObjectId();
    await expect(
      VoteModel.create({
        userId,
        dayKey: '2026-04-27',
        target: 'creator-x',
        tier: 'PLATINUM' as unknown as 'PUBLIC',
      }),
    ).rejects.toMatchObject({ name: 'ValidationError' });
  });

  it('compound unique index permits one vote per (user, tier, day)', async () => {
    const userId = new Types.ObjectId();
    // Same user, same day, three different tiers — all succeed.
    await VoteModel.create({ userId, dayKey: '2026-04-27', tier: 'PUBLIC', target: 'a' });
    await VoteModel.create({ userId, dayKey: '2026-04-27', tier: 'PRO', target: 'b' });
    await VoteModel.create({ userId, dayKey: '2026-04-27', tier: 'PRO_MAX', target: 'c' });
    expect(await VoteModel.countDocuments({ userId })).toBe(3);
  });

  it('compound unique index BLOCKS duplicate (user, tier, day)', async () => {
    const userId = new Types.ObjectId();
    await VoteModel.create({ userId, dayKey: '2026-04-27', tier: 'PUBLIC', target: 'a' });
    await expect(
      VoteModel.create({ userId, dayKey: '2026-04-27', tier: 'PUBLIC', target: 'b' }),
    ).rejects.toMatchObject({ code: 11000 });
  });

  it('legacy unique index {userId,dayKey} is not present after syncIndexes', async () => {
    const indexes = await VoteModel.collection.getIndexes();
    const indexNames = Object.keys(indexes);
    // Legacy single-key compound (the pre-11.0 unique) was named
    // `userId_1_dayKey_1`. The new compound is
    // `userId_1_tier_1_dayKey_1`. Allow the test runner's
    // syncIndexes to have run; the legacy must be gone.
    expect(indexNames).toContain('userId_1_tier_1_dayKey_1');
    expect(indexNames).not.toContain('userId_1_dayKey_1');
  });
});
