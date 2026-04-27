import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  clearAllCollections,
  connectTestMongo,
  disconnectTestMongo,
} from '../../../test/testing/mongo.js';
import { RedeemCodeModel } from './RedeemCode.model.js';

/**
 * Phase 11.0 — schema-level coverage for `RedeemCode.tier` and the
 * new `{tier, status, postId}` compound index used by Phase 11.4
 * tier-scoped FCFS scans.
 */
beforeAll(async () => {
  await connectTestMongo();
  await RedeemCodeModel.syncIndexes();
}, 30_000);

afterAll(async () => {
  await disconnectTestMongo();
});

beforeEach(async () => {
  await clearAllCollections();
});

describe('RedeemCode model — Phase 11.0 tier additions', () => {
  it("`tier` defaults to 'PUBLIC' when omitted on insert", async () => {
    const code = await RedeemCodeModel.create({
      batchId: new Types.ObjectId(),
      denomination: 5000,
      codeCt: 'CIPHER',
      codeHash: 'unique-hash-1',
    });
    expect(code.tier).toBe('PUBLIC');
  });

  it('rejects an invalid `tier` value', async () => {
    await expect(
      RedeemCodeModel.create({
        batchId: new Types.ObjectId(),
        denomination: 5000,
        codeCt: 'CIPHER',
        codeHash: 'unique-hash-2',
        tier: 'GOLD' as unknown as 'PUBLIC',
      }),
    ).rejects.toMatchObject({ name: 'ValidationError' });
  });

  it('preserves the existing {postId, status} index AND adds {tier, status, postId}', async () => {
    const indexes = await RedeemCodeModel.collection.getIndexes();
    const indexNames = Object.keys(indexes);
    expect(indexNames).toContain('postId_1_status_1');
    expect(indexNames).toContain('tier_1_status_1_postId_1');
  });
});
