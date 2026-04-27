import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone.js';
import utc from 'dayjs/plugin/utc.js';
import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppConfigModel } from '../../../src/shared/models/AppConfig.model.js';
import { DonationModel } from '../../../src/shared/models/Donation.model.js';
import { PrizePoolModel } from '../../../src/shared/models/PrizePool.model.js';
import { VoteModel } from '../../../src/shared/models/Vote.model.js';
import { createPrizePoolHandler } from '../../../src/workers/prize-pool.worker.js';
import { connectHarness, disconnectHarness, resetFullState } from './_harness.js';

dayjs.extend(utc);
dayjs.extend(timezone);

/**
 * Integration — prize-pool cron handler against real Mongo, Phase
 * 11.2 fanout posture. Each handler invocation produces three
 * prize_pool rows (one per tier) keyed by the {tier, dayKey}
 * unique index from Phase 11.0. Tier-pure aggregation reads
 * Vote.tier directly (Phase 11.1 snapshot) — no $lookup users.
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

describe('[integration] prize-pool cron handler — Phase 11.2 per-tier fanout', () => {
  it('mixed-tier votes → 3 prize_pool rows materialize, each with tier-pure math', async () => {
    const yesterdayDayKey = '2026-04-23';

    await AppConfigModel.updateOne(
      { key: 'default' },
      { $set: { baseRatePerVote: 100, proMultiplier: 5, proMaxMultiplier: 10 } },
      { upsert: true },
    );

    // 5 PUBLIC + 3 PRO + 2 PRO_MAX votes on yesterday.
    const tierMix: Array<['PUBLIC' | 'PRO' | 'PRO_MAX', number]> = [
      ['PUBLIC', 5],
      ['PRO', 3],
      ['PRO_MAX', 2],
    ];
    for (const [tier, count] of tierMix) {
      for (let i = 0; i < count; i++) {
        await VoteModel.create({
          userId: new Types.ObjectId(),
          dayKey: yesterdayDayKey,
          tier,
          target: `target-${tier}-${i}`,
          coinsSpent: 3,
        });
      }
    }

    const handler = createPrizePoolHandler();
    const scheduledFor = '2026-04-24T00:00:00+05:30';

    const result = await handler({ scheduledFor });
    expect(result.perTier).toHaveLength(3);

    // Verify per-tier rows exist with the expected totals.
    const rows = await PrizePoolModel.find({ dayKey: '2026-04-24' }).sort({ tier: 1 });
    expect(rows).toHaveLength(3);

    const byTier = Object.fromEntries(rows.map((r) => [r.tier, r]));
    expect(byTier['PUBLIC']?.totalPool).toBe(500); // 5 × 100 × 1
    expect(byTier['PRO']?.totalPool).toBe(1500); // 3 × 100 × 5
    expect(byTier['PRO_MAX']?.totalPool).toBe(2000); // 2 × 100 × 10

    // Multipliers stored on each row for audit.
    for (const row of rows) {
      expect(row.proMultiplier).toBe(5);
      expect(row.proMaxMultiplier).toBe(10);
    }

    // Idempotency — second invocation produces no new rows.
    const result2 = await handler({ scheduledFor });
    expect(result2.perTier.every((p) => !p.created)).toBe(true);
    expect(await PrizePoolModel.countDocuments({ dayKey: '2026-04-24' })).toBe(3);
  });

  it('CAPTURED donation in IST yesterday window contributes to PUBLIC pool only', async () => {
    const yesterdayDayKey = '2026-04-23';

    await AppConfigModel.updateOne(
      { key: 'default' },
      { $set: { baseRatePerVote: 100, proMultiplier: 5, proMaxMultiplier: 10 } },
      { upsert: true },
    );

    // 1 vote per tier so each pool has a non-zero baseline.
    for (const tier of ['PUBLIC', 'PRO', 'PRO_MAX'] as const) {
      await VoteModel.create({
        userId: new Types.ObjectId(),
        dayKey: yesterdayDayKey,
        tier,
        target: `target-${tier}`,
        coinsSpent: 3,
      });
    }

    // CAPTURED donation captured at IST midday yesterday.
    await DonationModel.create({
      isAnonymous: true,
      amount: 12345,
      razorpayOrderId: 'order_smoke_donation',
      status: 'CAPTURED',
      capturedAt: dayjs.tz('2026-04-23 12:00', 'Asia/Kolkata').toDate(),
    });

    const handler = createPrizePoolHandler();
    const result = await handler({ scheduledFor: '2026-04-24T00:00:00+05:30' });
    expect(result.perTier).toHaveLength(3);

    const rows = await PrizePoolModel.find({ dayKey: '2026-04-24' });
    const byTier = Object.fromEntries(rows.map((r) => [r.tier, r]));

    // PUBLIC pool: 1 × 100 × 1 + 12345 = 12445.
    expect(byTier['PUBLIC']?.totalPool).toBe(12445);
    // PRO pool: 1 × 100 × 5 = 500. No donation contribution.
    expect(byTier['PRO']?.totalPool).toBe(500);
    // PRO_MAX pool: 1 × 100 × 10 = 1000. No donation contribution.
    expect(byTier['PRO_MAX']?.totalPool).toBe(1000);
  });
});
