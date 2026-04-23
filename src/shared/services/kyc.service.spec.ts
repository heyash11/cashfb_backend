import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  clearAllCollections,
  connectTestMongo,
  disconnectTestMongo,
} from '../../../test/testing/mongo.js';
import { AppConfigModel } from '../models/AppConfig.model.js';
import { MODELS } from '../models/index.js';
import { PrizePoolWinnerModel } from '../models/PrizePoolWinner.model.js';
import { UserModel, type UserAttrs } from '../models/User.model.js';
import { KycService } from './kyc.service.js';

type AnyModel = { syncIndexes(): Promise<string[]> };

async function seedUser(kyc: Partial<UserAttrs['kyc']> = {}): Promise<UserAttrs> {
  const u = await UserModel.create({
    phone: `9${Math.floor(100000000 + Math.random() * 899999999)}`,
    dob: new Date('1998-01-01'),
    declaredState: 'IN-MH',
    kyc: { status: 'NONE', ...kyc },
  });
  return u.toObject();
}

async function seedWinner(
  userId: Types.ObjectId,
  opts: {
    finalAmount: number;
    payoutStatus: 'PENDING' | 'RELEASED' | 'WITHHELD' | 'VOID';
    createdAt?: Date;
  },
): Promise<void> {
  // Bypass Mongoose and hit the raw driver so we can pin createdAt.
  // Mongoose `timestamps: true` otherwise stamps createdAt on the
  // first .create() and resists $set overrides — not viable for FY
  // boundary tests that need seeded historical timestamps.
  const when = opts.createdAt ?? new Date();
  await PrizePoolWinnerModel.collection.insertOne({
    _id: new Types.ObjectId(),
    dayKey: '2026-04-24',
    userId,
    // Unique redeemCodeId per row — the schema has a partial
    // unique index on {userId, dayKey, type, redeemCodeId} filtered
    // by type=GIFT_CODE, so two null-redeemCodeId rows collide.
    redeemCodeId: new Types.ObjectId(),
    type: 'GIFT_CODE',
    tier: 'PUBLIC',
    baseAmount: opts.finalAmount,
    multiplier: 1,
    finalAmount: opts.finalAmount,
    tdsDeducted: 0,
    payoutStatus: opts.payoutStatus,
    createdAt: when,
    updatedAt: when,
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

describe('KycService', () => {
  const service = new KycService();

  it('getKycStatus returns NONE for brand-new user; reflects VERIFIED + panLast4 after update', async () => {
    const user = await seedUser();
    const initial = await service.getKycStatus(user._id);
    expect(initial.status).toBe('NONE');
    expect(initial.panLast4).toBeUndefined();

    await UserModel.updateOne(
      { _id: user._id },
      { $set: { 'kyc.status': 'VERIFIED', 'kyc.panLast4': '4321', 'kyc.verifiedAt': new Date() } },
    );
    const verified = await service.getKycStatus(user._id);
    expect(verified.status).toBe('VERIFIED');
    expect(verified.panLast4).toBe('4321');
    expect(verified.verifiedAt).toBeDefined();
  });

  it('cumulativeFyPrizeValue sums PENDING + RELEASED, excludes WITHHELD + VOID', async () => {
    const user = await seedUser();
    // Anchor the "now" inside FY 2026-27.
    const midFy = new Date('2026-07-15T12:00:00Z');
    const within = new Date('2026-06-10T08:00:00Z');

    await seedWinner(user._id, {
      finalAmount: 500_000,
      payoutStatus: 'PENDING',
      createdAt: within,
    });
    await seedWinner(user._id, {
      finalAmount: 300_000,
      payoutStatus: 'RELEASED',
      createdAt: within,
    });
    await seedWinner(user._id, {
      finalAmount: 999_999,
      payoutStatus: 'WITHHELD',
      createdAt: within,
    });
    await seedWinner(user._id, { finalAmount: 777_777, payoutStatus: 'VOID', createdAt: within });
    // A row from the prior FY must be excluded.
    await seedWinner(user._id, {
      finalAmount: 9_999_999,
      payoutStatus: 'PENDING',
      createdAt: new Date('2026-02-15T00:00:00Z'),
    });

    const result = await service.cumulativeFyPrizeValue(user._id, midFy);
    expect(result.totalPaise).toBe(800_000);
    expect(result.winnerCount).toBe(2);
    expect(result.fyStart.toISOString()).toBe('2026-03-31T18:30:00.000Z');
    expect(result.fyEnd.toISOString()).toBe('2027-03-31T18:29:59.999Z');
  });

  it('evaluateGate: under threshold allows regardless of KYC status', async () => {
    const user = await seedUser({ status: 'NONE' });
    await AppConfigModel.create({ key: 'default', kycThresholdAmount: 1_000_000 });
    const midFy = new Date('2026-07-15T12:00:00Z');
    await seedWinner(user._id, { finalAmount: 500_000, payoutStatus: 'PENDING', createdAt: midFy });

    const decision = await service.evaluateGate(user._id, midFy);
    expect(decision.allowed).toBe(true);
    expect(decision.cumulativePaise).toBe(500_000);
    expect(decision.thresholdPaise).toBe(1_000_000);
    expect(decision.kycStatus).toBe('NONE');
  });

  it('evaluateGate: over threshold + NOT VERIFIED blocks; same cumulative + VERIFIED allows', async () => {
    const blocked = await seedUser({ status: 'NONE' });
    const verified = await seedUser({ status: 'VERIFIED', panLast4: '1234' });
    await AppConfigModel.create({ key: 'default', kycThresholdAmount: 1_000_000 });
    const midFy = new Date('2026-07-15T12:00:00Z');

    for (const uid of [blocked._id, verified._id]) {
      await seedWinner(uid, {
        finalAmount: 1_500_000,
        payoutStatus: 'PENDING',
        createdAt: midFy,
      });
    }

    const blockedDecision = await service.evaluateGate(blocked._id, midFy);
    expect(blockedDecision.allowed).toBe(false);
    expect(blockedDecision.reason).toBe('CUMULATIVE_FY_EXCEEDS_THRESHOLD_KYC_NOT_VERIFIED');
    expect(blockedDecision.cumulativePaise).toBe(1_500_000);
    expect(blockedDecision.kycStatus).toBe('NONE');

    const verifiedDecision = await service.evaluateGate(verified._id, midFy);
    expect(verifiedDecision.allowed).toBe(true);
    expect(verifiedDecision.cumulativePaise).toBe(1_500_000);
    expect(verifiedDecision.kycStatus).toBe('VERIFIED');
  });
});
