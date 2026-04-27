import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  clearAllCollections,
  connectTestMongo,
  disconnectTestMongo,
} from '../../../test/testing/mongo.js';
import { VoteModel } from '../../shared/models/Vote.model.js';
import { runBackfillVoteTier } from './backfill-vote-tier.js';

beforeAll(async () => {
  await connectTestMongo();
}, 30_000);

afterAll(async () => {
  await disconnectTestMongo();
});

beforeEach(async () => {
  await clearAllCollections();
});

describe('runBackfillVoteTier', () => {
  it('empty collection — no-op, scanned/updated/skipped all 0', async () => {
    const report = await runBackfillVoteTier();
    expect(report).toEqual({ collection: 'votes', scanned: 0, updated: 0, skipped: 0 });
  });

  it("legacy votes (no tier field) all become tier='PUBLIC'", async () => {
    // Bypass mongoose default by inserting raw via the collection driver.
    await VoteModel.collection.insertMany([
      { userId: new Types.ObjectId(), dayKey: '2026-04-26', target: 'a', coinsSpent: 3 },
      { userId: new Types.ObjectId(), dayKey: '2026-04-26', target: 'b', coinsSpent: 3 },
      { userId: new Types.ObjectId(), dayKey: '2026-04-26', target: 'c', coinsSpent: 3 },
    ]);

    const report = await runBackfillVoteTier();
    expect(report.scanned).toBe(3);
    expect(report.updated).toBe(3);

    const tieredCount = await VoteModel.countDocuments({ tier: 'PUBLIC' });
    expect(tieredCount).toBe(3);
  });

  it('idempotent: re-running on already-migrated rows updates nothing', async () => {
    await VoteModel.collection.insertMany([
      { userId: new Types.ObjectId(), dayKey: '2026-04-26', target: 'a', coinsSpent: 3 },
    ]);
    await runBackfillVoteTier();
    const second = await runBackfillVoteTier();
    expect(second).toEqual({ collection: 'votes', scanned: 0, updated: 0, skipped: 0 });
  });

  it('does not touch rows that already have an explicit non-PUBLIC tier', async () => {
    const userId = new Types.ObjectId();
    await VoteModel.collection.insertMany([
      { userId, dayKey: '2026-04-26', tier: 'PRO', target: 'a', coinsSpent: 3 },
      { userId: new Types.ObjectId(), dayKey: '2026-04-26', target: 'b', coinsSpent: 3 },
    ]);
    const report = await runBackfillVoteTier();
    expect(report.scanned).toBe(1);
    expect(report.updated).toBe(1);
    const proStill = await VoteModel.countDocuments({ tier: 'PRO' });
    expect(proStill).toBe(1);
  });
});
