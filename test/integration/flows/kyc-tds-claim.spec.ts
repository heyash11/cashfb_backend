import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import { InMemoryEncryptor } from '../../../src/shared/encryption/in-memory.js';
import { AdminRedeemCodeService } from '../../../src/modules/redeem-codes/redeem-codes.admin.service.js';
import { RedeemCodeService } from '../../../src/modules/redeem-codes/redeem-codes.service.js';
import { AppConfigModel } from '../../../src/shared/models/AppConfig.model.js';
import { PostCompletionModel } from '../../../src/shared/models/PostCompletion.model.js';
import { PostModel } from '../../../src/shared/models/Post.model.js';
import { PrizePoolWinnerModel } from '../../../src/shared/models/PrizePoolWinner.model.js';
import { RedeemCodeModel } from '../../../src/shared/models/RedeemCode.model.js';
import { UserModel } from '../../../src/shared/models/User.model.js';
import { connectHarness, disconnectHarness, resetFullState } from './_harness.js';

/**
 * Integration — Phase 8 KYC gate + transactional TDS write against
 * the real docker replset. End-to-end: admin upload + publish +
 * user claim, with pre-existing PrizePoolWinner rows pushing
 * cumulative FY above threshold.
 *
 * Regression guard for Chunk 4: the gate must block NOT-VERIFIED
 * users over threshold (451 KYC_REQUIRED), and the claim path's
 * Mongo transaction must atomically flip the FCFS code + write
 * TDS onto the linked winner row.
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

async function seedCodeForUser(
  admin: AdminRedeemCodeService,
  userId: Types.ObjectId,
  label: string,
) {
  const actor = new Types.ObjectId();
  const post = await PostModel.create({
    title: `KYC post ${label}`,
    dayKey: '2026-04-24',
    scheduledAt: new Date(),
    status: 'LIVE',
    coinReward: 1,
    tierRequired: 'PUBLIC',
    createdBy: actor,
  });
  await PostCompletionModel.create({
    userId,
    postId: post._id,
    dayKey: '2026-04-24',
    coinAwarded: 1,
  });
  const csv = Buffer.from(`code,denomination\n${label}-CODE,5000\n`, 'utf8');
  const batch = await admin.uploadBatch(
    { csvBuffer: csv, supplierName: 'Xoxoday', denomination: 5000 },
    actor,
  );
  await admin.publishBatchToPost({ batchId: batch.batchId, postId: post._id, count: 1 }, actor);
  const code = await RedeemCodeModel.findOne({ batchId: batch.batchId });
  if (!code) throw new Error('code seed missing');
  return code._id;
}

describe('[integration] KYC + TDS claim gate', () => {
  it('NOT-VERIFIED user over cumulative-FY threshold is blocked with 451 KYC_REQUIRED', async () => {
    const encryptor = new InMemoryEncryptor();
    const admin = new AdminRedeemCodeService({ encryptor });
    const user = new RedeemCodeService({ encryptor });

    await AppConfigModel.updateOne(
      { key: 'default' },
      { $set: { kycThresholdAmount: 1_000_000 } },
      { upsert: true },
    );

    const rawUser = await UserModel.create({
      phone: '+9199991ABOVE1',
      dob: new Date('1995-01-01'),
      declaredState: 'IN-MH',
      tier: 'PUBLIC',
      kyc: { status: 'NONE' },
    });
    const codeId = await seedCodeForUser(admin, rawUser._id, 'BLOCK');

    // 1.5M paise PENDING prior winnings → over threshold.
    await PrizePoolWinnerModel.collection.insertOne({
      _id: new Types.ObjectId(),
      dayKey: '2026-04-20',
      userId: rawUser._id,
      redeemCodeId: new Types.ObjectId(),
      type: 'GIFT_CODE',
      tier: 'PUBLIC',
      baseAmount: 1_500_000,
      multiplier: 1,
      finalAmount: 1_500_000,
      tdsDeducted: 0,
      payoutStatus: 'PENDING',
      createdAt: new Date('2026-04-20T00:00:00Z'),
      updatedAt: new Date('2026-04-20T00:00:00Z'),
    });

    await expect(user.claim(codeId, rawUser._id)).rejects.toMatchObject({
      code: 'KYC_REQUIRED',
      httpStatus: 451,
    });

    const codeAfter = await RedeemCodeModel.findById(codeId);
    expect(codeAfter?.status).toBe('PUBLISHED'); // not flipped
  });

  it('VERIFIED user over threshold: claim OK, linked PrizePoolWinner flipped to RELEASED with TDS + panAtPayout', async () => {
    const encryptor = new InMemoryEncryptor();
    const admin = new AdminRedeemCodeService({ encryptor });
    const user = new RedeemCodeService({ encryptor });

    await AppConfigModel.updateOne(
      { key: 'default' },
      { $set: { kycThresholdAmount: 1_000_000 } },
      { upsert: true },
    );

    const rawUser = await UserModel.create({
      phone: '+9199991ABOVE2',
      dob: new Date('1995-01-01'),
      declaredState: 'IN-MH',
      tier: 'PUBLIC',
      kyc: { status: 'VERIFIED', panLast4: '9999', verifiedAt: new Date() },
    });
    const codeId = await seedCodeForUser(admin, rawUser._id, 'ALLOW');

    // Linked winner (TDS target) — 5000 paise prize.
    const linkedWinnerId = new Types.ObjectId();
    await PrizePoolWinnerModel.collection.insertOne({
      _id: linkedWinnerId,
      dayKey: '2026-04-24',
      userId: rawUser._id,
      redeemCodeId: codeId,
      type: 'GIFT_CODE',
      tier: 'PUBLIC',
      baseAmount: 5000,
      multiplier: 1,
      finalAmount: 5000,
      tdsDeducted: 0,
      payoutStatus: 'PENDING',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    // Separate PENDING row that pushes cumulative above threshold.
    await PrizePoolWinnerModel.collection.insertOne({
      _id: new Types.ObjectId(),
      dayKey: '2026-04-20',
      userId: rawUser._id,
      redeemCodeId: new Types.ObjectId(),
      type: 'GIFT_CODE',
      tier: 'PUBLIC',
      baseAmount: 1_200_000,
      multiplier: 1,
      finalAmount: 1_200_000,
      tdsDeducted: 0,
      payoutStatus: 'PENDING',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await user.claim(codeId, rawUser._id);
    expect(result.tds).not.toBeNull();
    expect(result.tds?.deductedPaise).toBe(1500); // 30% of 5000

    const flipped = await PrizePoolWinnerModel.findById(linkedWinnerId);
    expect(flipped?.payoutStatus).toBe('RELEASED');
    expect(flipped?.tdsDeducted).toBe(1500);
    expect(flipped?.panAtPayout).toBe('XXXXX9999');
    expect(flipped?.releasedAt).toBeDefined();
  });
});
