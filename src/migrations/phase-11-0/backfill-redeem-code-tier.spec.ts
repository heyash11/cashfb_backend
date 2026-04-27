import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  clearAllCollections,
  connectTestMongo,
  disconnectTestMongo,
} from '../../../test/testing/mongo.js';
import { PostModel } from '../../shared/models/Post.model.js';
import { RedeemCodeModel } from '../../shared/models/RedeemCode.model.js';
import { runBackfillRedeemCodeTier } from './backfill-redeem-code-tier.js';

beforeAll(async () => {
  await connectTestMongo();
}, 30_000);

afterAll(async () => {
  await disconnectTestMongo();
});

beforeEach(async () => {
  await clearAllCollections();
});

async function seedPost(tier: 'PUBLIC' | 'PRO' | 'PRO_MAX'): Promise<Types.ObjectId> {
  const post = await PostModel.create({
    title: `Post ${tier}`,
    dayKey: '2026-04-26',
    scheduledAt: new Date('2026-04-26T17:00:00Z'),
    tier,
    createdBy: new Types.ObjectId(),
  });
  return post._id;
}

async function seedLegacyCode(opts: { postId?: Types.ObjectId; hash: string }): Promise<void> {
  await RedeemCodeModel.collection.insertOne({
    batchId: new Types.ObjectId(),
    denomination: 5000,
    codeCt: 'CIPHER',
    codeHash: opts.hash,
    status: 'AVAILABLE',
    copyCount: 0,
    ...(opts.postId ? { postId: opts.postId } : {}),
  });
}

describe('runBackfillRedeemCodeTier', () => {
  it('empty collection — no-op', async () => {
    const report = await runBackfillRedeemCodeTier();
    expect(report.scanned).toBe(0);
    expect(report.updated).toBe(0);
    expect(report.orphans).toBe(0);
    expect(report.postless).toBe(0);
  });

  it('codes inherit `tier` from parent Post.tierRequired', async () => {
    const publicPostId = await seedPost('PUBLIC');
    const proPostId = await seedPost('PRO');
    const proMaxPostId = await seedPost('PRO_MAX');

    await seedLegacyCode({ postId: publicPostId, hash: 'h-pub-1' });
    await seedLegacyCode({ postId: proPostId, hash: 'h-pro-1' });
    await seedLegacyCode({ postId: proPostId, hash: 'h-pro-2' });
    await seedLegacyCode({ postId: proMaxPostId, hash: 'h-pmax-1' });

    const report = await runBackfillRedeemCodeTier();
    expect(report.scanned).toBe(4);
    expect(report.updated).toBe(4);

    expect(await RedeemCodeModel.countDocuments({ tier: 'PRO' })).toBe(2);
    expect(await RedeemCodeModel.countDocuments({ tier: 'PRO_MAX' })).toBe(1);
    expect(await RedeemCodeModel.countDocuments({ tier: 'PUBLIC' })).toBe(1);
  });

  it("orphan codes (postId set but Post missing) default to 'PUBLIC' and are reported", async () => {
    const ghostPostId = new Types.ObjectId();
    await seedLegacyCode({ postId: ghostPostId, hash: 'h-orphan-1' });
    await seedLegacyCode({ postId: ghostPostId, hash: 'h-orphan-2' });

    const report = await runBackfillRedeemCodeTier();
    expect(report.orphans).toBe(1); // unique ghostPostId, not row count
    expect(await RedeemCodeModel.countDocuments({ tier: 'PUBLIC' })).toBe(2);
  });

  it("postless codes (no postId at all) default to 'PUBLIC' and are reported", async () => {
    await seedLegacyCode({ hash: 'h-postless-1' });
    await seedLegacyCode({ hash: 'h-postless-2' });

    const report = await runBackfillRedeemCodeTier();
    expect(report.postless).toBe(2);
    expect(await RedeemCodeModel.countDocuments({ tier: 'PUBLIC' })).toBe(2);
  });

  it('idempotent re-run', async () => {
    const proPostId = await seedPost('PRO');
    await seedLegacyCode({ postId: proPostId, hash: 'h-1' });

    await runBackfillRedeemCodeTier();
    const second = await runBackfillRedeemCodeTier();
    expect(second.scanned).toBe(0);
    expect(second.updated).toBe(0);
  });
});
