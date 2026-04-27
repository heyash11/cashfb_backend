import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone.js';
import utc from 'dayjs/plugin/utc.js';
import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  clearAllCollections,
  connectTestMongo,
  disconnectTestMongo,
} from '../../../test/testing/mongo.js';
import { AppConfigModel } from '../../shared/models/AppConfig.model.js';
import { DonationModel } from '../../shared/models/Donation.model.js';
import { MODELS } from '../../shared/models/index.js';
import { PrizePoolModel } from '../../shared/models/PrizePool.model.js';
import { VoteModel } from '../../shared/models/Vote.model.js';
import type { Tier } from '../../shared/models/_tier.js';
import { dayKeyIst, nowIst } from '../../shared/utils/date.js';
import { PrizePoolService } from './prize-pools.service.js';

dayjs.extend(utc);
dayjs.extend(timezone);

type AnyModel = { syncIndexes(): Promise<string[]> };

async function seedVotes(dayKey: string, tier: Tier, count: number): Promise<void> {
  const docs = Array.from({ length: count }, (_, i) => ({
    userId: new Types.ObjectId(),
    dayKey,
    tier,
    target: `creator-${tier}-${i}`,
    coinsSpent: 3,
  }));
  await VoteModel.insertMany(docs);
}

async function seedAppConfig(overrides: {
  baseRatePerVote?: number;
  proMultiplier?: number;
  proMaxMultiplier?: number;
}): Promise<void> {
  await AppConfigModel.updateOne({ key: 'default' }, { $set: overrides }, { upsert: true });
}

async function seedDonation(opts: {
  amount: number;
  status: 'CREATED' | 'CAPTURED' | 'FAILED' | 'REFUNDED';
  capturedAt?: Date;
}): Promise<void> {
  await DonationModel.create({
    isAnonymous: true,
    amount: opts.amount,
    razorpayOrderId: `order_${Math.random().toString(36).slice(2)}`,
    status: opts.status,
    ...(opts.capturedAt ? { capturedAt: opts.capturedAt } : {}),
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

describe('PrizePoolService.computeAndPublishPool — per-tier (Phase 11.2)', () => {
  // ---------------------------------------------------------------
  // Per-tier isolation — votes from other tiers must NOT bleed in
  // ---------------------------------------------------------------

  it('PUBLIC pool counts only PUBLIC votes; PRO and PRO_MAX votes do not bleed in', async () => {
    await seedAppConfig({ baseRatePerVote: 100, proMultiplier: 5, proMaxMultiplier: 10 });
    await seedVotes('2026-04-23', 'PUBLIC', 4);
    await seedVotes('2026-04-23', 'PRO', 2);
    await seedVotes('2026-04-23', 'PRO_MAX', 1);

    const svc = new PrizePoolService();
    const res = await svc.computeAndPublishPool({
      dayKey: '2026-04-24',
      yesterdayDayKey: '2026-04-23',
      tier: 'PUBLIC',
    });

    expect(res.created).toBe(true);
    expect(res.tier).toBe('PUBLIC');
    expect(res.voteCount).toBe(4); // only PUBLIC votes
    expect(res.tierMultiplier).toBe(1);
    expect(res.voteContributionPaise).toBe(400); // 4 × 100 × 1
    expect(res.donationContributionPaise).toBe(0);
    expect(res.totalPoolPaise).toBe(400);
  });

  it('PRO pool counts only PRO votes, applies proMultiplier; PUBLIC and PRO_MAX votes do not bleed in', async () => {
    await seedAppConfig({ baseRatePerVote: 100, proMultiplier: 5, proMaxMultiplier: 10 });
    await seedVotes('2026-04-23', 'PUBLIC', 4);
    await seedVotes('2026-04-23', 'PRO', 2);
    await seedVotes('2026-04-23', 'PRO_MAX', 1);

    const svc = new PrizePoolService();
    const res = await svc.computeAndPublishPool({
      dayKey: '2026-04-24',
      yesterdayDayKey: '2026-04-23',
      tier: 'PRO',
    });

    expect(res.tier).toBe('PRO');
    expect(res.voteCount).toBe(2);
    expect(res.tierMultiplier).toBe(5);
    expect(res.voteContributionPaise).toBe(1000); // 2 × 100 × 5
    expect(res.donationContributionPaise).toBe(0); // donations PUBLIC-only
    expect(res.totalPoolPaise).toBe(1000);
  });

  it('PRO_MAX pool counts only PRO_MAX votes, applies proMaxMultiplier', async () => {
    await seedAppConfig({ baseRatePerVote: 100, proMultiplier: 5, proMaxMultiplier: 10 });
    await seedVotes('2026-04-23', 'PUBLIC', 4);
    await seedVotes('2026-04-23', 'PRO', 2);
    await seedVotes('2026-04-23', 'PRO_MAX', 3);

    const svc = new PrizePoolService();
    const res = await svc.computeAndPublishPool({
      dayKey: '2026-04-24',
      yesterdayDayKey: '2026-04-23',
      tier: 'PRO_MAX',
    });

    expect(res.tier).toBe('PRO_MAX');
    expect(res.voteCount).toBe(3);
    expect(res.tierMultiplier).toBe(10);
    expect(res.voteContributionPaise).toBe(3000); // 3 × 100 × 10
    expect(res.donationContributionPaise).toBe(0);
    expect(res.totalPoolPaise).toBe(3000);
  });

  // ---------------------------------------------------------------
  // Multipliers — read from AppConfig at compute time, stored on row
  // ---------------------------------------------------------------

  it('respects custom multipliers from AppConfig (proMultiplier=3, proMaxMultiplier=7) and stores them on the row', async () => {
    await seedAppConfig({ baseRatePerVote: 100, proMultiplier: 3, proMaxMultiplier: 7 });
    await seedVotes('2026-04-23', 'PRO', 1);
    await seedVotes('2026-04-23', 'PRO_MAX', 1);

    const svc = new PrizePoolService();
    const proRes = await svc.computeAndPublishPool({
      dayKey: '2026-04-24',
      yesterdayDayKey: '2026-04-23',
      tier: 'PRO',
    });
    expect(proRes.tierMultiplier).toBe(3);
    expect(proRes.totalPoolPaise).toBe(300);

    const proMaxRes = await svc.computeAndPublishPool({
      dayKey: '2026-04-24',
      yesterdayDayKey: '2026-04-23',
      tier: 'PRO_MAX',
    });
    expect(proMaxRes.tierMultiplier).toBe(7);
    expect(proMaxRes.totalPoolPaise).toBe(700);

    // Stored on row for audit
    const proRow = await PrizePoolModel.findOne({ tier: 'PRO', dayKey: '2026-04-24' });
    expect(proRow?.proMultiplier).toBe(3);
    expect(proRow?.proMaxMultiplier).toBe(7);
  });

  // ---------------------------------------------------------------
  // Donation funding — PUBLIC pool only
  // ---------------------------------------------------------------

  it("PUBLIC pool adds yesterday's CAPTURED donation sum to totalPool", async () => {
    await seedAppConfig({ baseRatePerVote: 100 });
    await seedVotes('2026-04-23', 'PUBLIC', 2);
    // CAPTURED donation at IST midday yesterday
    await seedDonation({
      amount: 5000,
      status: 'CAPTURED',
      capturedAt: dayjs.tz('2026-04-23 12:00', 'Asia/Kolkata').toDate(),
    });

    const svc = new PrizePoolService();
    const res = await svc.computeAndPublishPool({
      dayKey: '2026-04-24',
      yesterdayDayKey: '2026-04-23',
      tier: 'PUBLIC',
    });

    expect(res.voteContributionPaise).toBe(200); // 2 × 100 × 1
    expect(res.donationContributionPaise).toBe(5000);
    expect(res.totalPoolPaise).toBe(5200);
  });

  it('CREATED / FAILED / REFUNDED donations do NOT contribute to PUBLIC pool', async () => {
    await seedAppConfig({ baseRatePerVote: 100 });
    await seedVotes('2026-04-23', 'PUBLIC', 1);
    const yesterdayNoon = dayjs.tz('2026-04-23 12:00', 'Asia/Kolkata').toDate();
    await seedDonation({ amount: 1000, status: 'CREATED', capturedAt: yesterdayNoon });
    await seedDonation({ amount: 2000, status: 'FAILED', capturedAt: yesterdayNoon });
    await seedDonation({ amount: 3000, status: 'REFUNDED', capturedAt: yesterdayNoon });

    const svc = new PrizePoolService();
    const res = await svc.computeAndPublishPool({
      dayKey: '2026-04-24',
      yesterdayDayKey: '2026-04-23',
      tier: 'PUBLIC',
    });

    expect(res.donationContributionPaise).toBe(0);
    expect(res.totalPoolPaise).toBe(100); // only the 1 PUBLIC vote
  });

  it('donations DO NOT contribute to PRO pool', async () => {
    await seedAppConfig({ baseRatePerVote: 100, proMultiplier: 5 });
    await seedVotes('2026-04-23', 'PRO', 1);
    await seedDonation({
      amount: 9999,
      status: 'CAPTURED',
      capturedAt: dayjs.tz('2026-04-23 12:00', 'Asia/Kolkata').toDate(),
    });

    const svc = new PrizePoolService();
    const res = await svc.computeAndPublishPool({
      dayKey: '2026-04-24',
      yesterdayDayKey: '2026-04-23',
      tier: 'PRO',
    });

    expect(res.donationContributionPaise).toBe(0);
    expect(res.totalPoolPaise).toBe(500); // 1 × 100 × 5
  });

  it('donations DO NOT contribute to PRO_MAX pool', async () => {
    await seedAppConfig({ baseRatePerVote: 100, proMaxMultiplier: 10 });
    await seedVotes('2026-04-23', 'PRO_MAX', 1);
    await seedDonation({
      amount: 9999,
      status: 'CAPTURED',
      capturedAt: dayjs.tz('2026-04-23 12:00', 'Asia/Kolkata').toDate(),
    });

    const svc = new PrizePoolService();
    const res = await svc.computeAndPublishPool({
      dayKey: '2026-04-24',
      yesterdayDayKey: '2026-04-23',
      tier: 'PRO_MAX',
    });

    expect(res.donationContributionPaise).toBe(0);
    expect(res.totalPoolPaise).toBe(1000); // 1 × 100 × 10
  });

  // ---------------------------------------------------------------
  // §R3 — Donation window boundary specs (3 cases)
  // ---------------------------------------------------------------

  it('boundary: CAPTURED at IST 23:59 yesterday → counts in PUBLIC pool', async () => {
    await seedAppConfig({ baseRatePerVote: 100 });
    await seedDonation({
      amount: 1234,
      status: 'CAPTURED',
      capturedAt: dayjs.tz('2026-04-23 23:59', 'Asia/Kolkata').toDate(),
    });

    const svc = new PrizePoolService();
    const res = await svc.computeAndPublishPool({
      dayKey: '2026-04-24',
      yesterdayDayKey: '2026-04-23',
      tier: 'PUBLIC',
    });

    expect(res.donationContributionPaise).toBe(1234);
  });

  it('boundary: CAPTURED at IST 00:01 today → does NOT count', async () => {
    await seedAppConfig({ baseRatePerVote: 100 });
    await seedDonation({
      amount: 9999,
      status: 'CAPTURED',
      capturedAt: dayjs.tz('2026-04-24 00:01', 'Asia/Kolkata').toDate(),
    });

    const svc = new PrizePoolService();
    const res = await svc.computeAndPublishPool({
      dayKey: '2026-04-24',
      yesterdayDayKey: '2026-04-23',
      tier: 'PUBLIC',
    });

    expect(res.donationContributionPaise).toBe(0);
  });

  it('boundary: CAPTURED at IST 23:59 two-days-ago → does NOT count (lower-bound off-by-one guard)', async () => {
    await seedAppConfig({ baseRatePerVote: 100 });
    await seedDonation({
      amount: 8888,
      status: 'CAPTURED',
      capturedAt: dayjs.tz('2026-04-22 23:59', 'Asia/Kolkata').toDate(),
    });

    const svc = new PrizePoolService();
    const res = await svc.computeAndPublishPool({
      dayKey: '2026-04-24',
      yesterdayDayKey: '2026-04-23',
      tier: 'PUBLIC',
    });

    expect(res.donationContributionPaise).toBe(0);
  });

  // ---------------------------------------------------------------
  // Idempotency — Pattern 1 upsert against {tier, dayKey}
  // ---------------------------------------------------------------

  it('writes exactly one row per (tier, dayKey); re-invocation returns {created: false} with stored values', async () => {
    await seedAppConfig({ baseRatePerVote: 100 });
    await seedVotes('2026-04-23', 'PUBLIC', 3);

    const svc = new PrizePoolService();
    const first = await svc.computeAndPublishPool({
      dayKey: '2026-04-24',
      yesterdayDayKey: '2026-04-23',
      tier: 'PUBLIC',
    });
    expect(first.created).toBe(true);
    expect(first.totalPoolPaise).toBe(300);

    const second = await svc.computeAndPublishPool({
      dayKey: '2026-04-24',
      yesterdayDayKey: '2026-04-23',
      tier: 'PUBLIC',
    });
    expect(second.created).toBe(false);
    expect(second.totalPoolPaise).toBe(300);
    expect(second.tier).toBe('PUBLIC');

    expect(await PrizePoolModel.countDocuments({ tier: 'PUBLIC', dayKey: '2026-04-24' })).toBe(1);
  });

  it('three separate (tier, dayKey) computations land in three distinct rows', async () => {
    await seedAppConfig({ baseRatePerVote: 100, proMultiplier: 5, proMaxMultiplier: 10 });
    await seedVotes('2026-04-23', 'PUBLIC', 1);
    await seedVotes('2026-04-23', 'PRO', 1);
    await seedVotes('2026-04-23', 'PRO_MAX', 1);

    const svc = new PrizePoolService();
    for (const tier of ['PUBLIC', 'PRO', 'PRO_MAX'] as const) {
      const res = await svc.computeAndPublishPool({
        dayKey: '2026-04-24',
        yesterdayDayKey: '2026-04-23',
        tier,
      });
      expect(res.created).toBe(true);
    }

    const rows = await PrizePoolModel.find({ dayKey: '2026-04-24' }).sort({ tier: 1 });
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.tier).sort()).toEqual(['PRO', 'PRO_MAX', 'PUBLIC']);
  });

  // ---------------------------------------------------------------
  // Edge cases — zero votes, odd-paisa, status field
  // ---------------------------------------------------------------

  it('zero votes for the requested tier: row written with totalPool=0, status CALCULATED', async () => {
    await seedAppConfig({ baseRatePerVote: 100 });
    // No votes seeded.

    const svc = new PrizePoolService();
    const res = await svc.computeAndPublishPool({
      dayKey: '2026-04-24',
      yesterdayDayKey: '2026-04-23',
      tier: 'PUBLIC',
    });

    expect(res).toMatchObject({
      created: true,
      tier: 'PUBLIC',
      voteCount: 0,
      totalPoolPaise: 0,
      voteContributionPaise: 0,
      donationContributionPaise: 0,
    });

    const row = await PrizePoolModel.findOne({ tier: 'PUBLIC', dayKey: '2026-04-24' });
    expect(row?.totalPool).toBe(0);
    expect(row?.status).toBe('CALCULATED');
  });

  it('odd-paisa split: 1001-paise PUBLIC pool → giftCode=700 + customRoom=301, components re-sum to total', async () => {
    await seedAppConfig({ baseRatePerVote: 143 });
    await seedVotes('2026-04-23', 'PUBLIC', 7); // 7 × 143 × 1 = 1001

    const svc = new PrizePoolService();
    const res = await svc.computeAndPublishPool({
      dayKey: '2026-04-24',
      yesterdayDayKey: '2026-04-23',
      tier: 'PUBLIC',
    });

    expect(res.totalPoolPaise).toBe(1001);
    expect(res.giftCodeBudgetPaise).toBe(700); // floor(0.7 × 1001)
    expect(res.customRoomBudgetPaise).toBe(301); // 1001 − 700
    expect(res.giftCodeBudgetPaise + res.customRoomBudgetPaise).toBe(res.totalPoolPaise);
  });
});

// ---------------------------------------------------------------
// Phase 11.6 — public read endpoint backing
// ---------------------------------------------------------------

describe('PrizePoolService.getTodayForTier — Phase 11.6 public read', () => {
  it('returns persisted row values with status=CALCULATED for PUBLIC tier when pool exists', async () => {
    const todayKey = dayKeyIst(nowIst());
    const calculatedAt = new Date('2026-04-25T00:05:00Z');
    await PrizePoolModel.create({
      tier: 'PUBLIC',
      dayKey: todayKey,
      yesterdayVoteCount: 100,
      baseRate: 100, // 1 INR / vote
      totalPool: 12000, // 100 votes × 100 paise + 2000 donations
      giftCodeBudget: 8400,
      customRoomBudget: 3600,
      proMultiplier: 5,
      proMaxMultiplier: 10,
      status: 'CALCULATED',
      calculatedAt,
    });

    const svc = new PrizePoolService();
    const res = await svc.getTodayForTier('PUBLIC');

    expect(res).toEqual({
      tier: 'PUBLIC',
      dayKey: todayKey,
      voteCount: 100,
      tierMultiplier: 1,
      baseRatePaise: 100,
      voteContributionPaise: 10000, // 100 × 100 × 1
      donationContributionPaise: 2000, // 12000 − 10000
      totalPoolPaise: 12000,
      giftCodeBudgetPaise: 8400,
      customRoomBudgetPaise: 3600,
      status: 'CALCULATED',
      calculatedAt,
    });
  });

  it('returns voteContribution × tierMultiplier=5 for PRO tier; donationContribution=0', async () => {
    const todayKey = dayKeyIst(nowIst());
    await PrizePoolModel.create({
      tier: 'PRO',
      dayKey: todayKey,
      yesterdayVoteCount: 50,
      baseRate: 100,
      totalPool: 25000, // 50 × 100 × 5 (no donation contribution for PRO)
      giftCodeBudget: 17500,
      customRoomBudget: 7500,
      proMultiplier: 5,
      proMaxMultiplier: 10,
      status: 'PUBLISHED',
      calculatedAt: new Date('2026-04-25T00:05:00Z'),
      publishedAt: new Date('2026-04-25T00:06:00Z'),
    });

    const svc = new PrizePoolService();
    const res = await svc.getTodayForTier('PRO');

    expect(res.tier).toBe('PRO');
    expect(res.tierMultiplier).toBe(5);
    expect(res.voteContributionPaise).toBe(25000); // 50 × 100 × 5
    expect(res.donationContributionPaise).toBe(0); // PRO carries no donation share
    expect(res.totalPoolPaise).toBe(25000);
    expect(res.status).toBe('PUBLISHED');
  });

  it('returns PENDING projection with all numerics 0 + calculatedAt: null when no pool row exists', async () => {
    // No insert — empty prize_pools collection.
    const svc = new PrizePoolService();
    const res = await svc.getTodayForTier('PUBLIC');

    expect(res.status).toBe('PENDING');
    expect(res.calculatedAt).toBeNull();
    expect(res.voteCount).toBe(0);
    expect(res.tierMultiplier).toBe(0);
    expect(res.baseRatePaise).toBe(0);
    expect(res.voteContributionPaise).toBe(0);
    expect(res.donationContributionPaise).toBe(0);
    expect(res.totalPoolPaise).toBe(0);
    expect(res.giftCodeBudgetPaise).toBe(0);
    expect(res.customRoomBudgetPaise).toBe(0);
    expect(res.dayKey).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(res.tier).toBe('PUBLIC');
  });

  it('PENDING isolation: a PRO pool exists for today but caller asks for PUBLIC → still PENDING', async () => {
    const todayKey = dayKeyIst(nowIst());
    await PrizePoolModel.create({
      tier: 'PRO',
      dayKey: todayKey,
      yesterdayVoteCount: 10,
      baseRate: 100,
      totalPool: 5000,
      proMultiplier: 5,
      proMaxMultiplier: 10,
      status: 'CALCULATED',
      calculatedAt: new Date(),
    });

    const svc = new PrizePoolService();
    const res = await svc.getTodayForTier('PUBLIC');
    expect(res.status).toBe('PENDING');
    expect(res.tier).toBe('PUBLIC');
  });
});
