import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  clearAllCollections,
  connectTestMongo,
  disconnectTestMongo,
} from '../../../test/testing/mongo.js';
import { MODELS } from '../../shared/models/index.js';
import { RedeemCodeModel } from '../../shared/models/RedeemCode.model.js';
import { reconcileCopiedCodes } from './redeem-codes.reconcile.js';

type AnyModel = { syncIndexes(): Promise<string[]> };

async function mkCopied(firstCopiedAt: Date, firstCopiedBy = new Types.ObjectId()) {
  return RedeemCodeModel.create({
    batchId: new Types.ObjectId(),
    denomination: 5000,
    codeCt: 'ct',
    codeIv: 'iv',
    codeTag: 'tag',
    codeDekEnc: 'dek',
    codeHash: new Types.ObjectId().toHexString(),
    status: 'COPIED',
    copyCount: 1,
    firstCopiedAt,
    firstCopiedBy,
    postId: new Types.ObjectId(),
  });
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

describe('reconcileCopiedCodes', () => {
  it('flips 2 codes COPIED > 24h to CLAIMED; leaves 2 codes within 24h untouched', async () => {
    const now = new Date('2026-04-23T12:00:00Z');
    const MS_24H = 24 * 60 * 60 * 1000;

    const oldA = await mkCopied(new Date(now.getTime() - MS_24H - 60_000));
    const oldB = await mkCopied(new Date(now.getTime() - MS_24H - 2 * 60 * 60_000));
    const newA = await mkCopied(new Date(now.getTime() - MS_24H + 60_000)); // 23h 59m
    const newB = await mkCopied(new Date(now.getTime() - 60_000)); // 1 minute ago

    const result = await reconcileCopiedCodes({ now });
    expect(result.reconciled).toBe(2);

    const afterOldA = await RedeemCodeModel.findById(oldA._id);
    const afterOldB = await RedeemCodeModel.findById(oldB._id);
    const afterNewA = await RedeemCodeModel.findById(newA._id);
    const afterNewB = await RedeemCodeModel.findById(newB._id);

    expect(afterOldA?.status).toBe('CLAIMED');
    expect(afterOldB?.status).toBe('CLAIMED');
    expect(afterNewA?.status).toBe('COPIED');
    expect(afterNewB?.status).toBe('COPIED');

    expect(afterOldA?.claimedAt?.toISOString()).toBe(now.toISOString());
    expect(String(afterOldA?.claimedBy)).toBe(String(afterOldA?.firstCopiedBy));
  });
});
