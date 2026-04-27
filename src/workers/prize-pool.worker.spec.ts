import { describe, expect, it, vi } from 'vitest';
import type {
  ComputeAndPublishInput,
  ComputeAndPublishResult,
  PrizePoolService,
} from '../modules/prize-pools/prize-pools.service.js';
import type { Tier } from '../shared/models/_tier.js';
import { createPrizePoolHandler } from './prize-pool.worker.js';

function fakeResult(overrides: Partial<ComputeAndPublishResult> = {}): ComputeAndPublishResult {
  return {
    created: true,
    tier: 'PUBLIC',
    voteCount: 0,
    tierMultiplier: 1,
    baseRatePaise: 100,
    voteContributionPaise: 0,
    donationContributionPaise: 0,
    totalPoolPaise: 0,
    giftCodeBudgetPaise: 0,
    customRoomBudgetPaise: 0,
    ...overrides,
  };
}

function fakeService(impl?: (input: ComputeAndPublishInput) => Promise<ComputeAndPublishResult>): {
  service: PrizePoolService;
  spy: ReturnType<typeof vi.fn>;
} {
  const spy = vi.fn(impl ?? (async (input) => fakeResult({ tier: input.tier })));
  return { service: { computeAndPublishPool: spy } as unknown as PrizePoolService, spy };
}

describe('prize-pool worker handler — Phase 11.2 fanout', () => {
  it('fans out one call per tier (PUBLIC, PRO, PRO_MAX) with the same dayKey + yesterdayDayKey', async () => {
    const { service, spy } = fakeService();
    const handler = createPrizePoolHandler({ service });

    // 06:00 UTC on 2026-04-24 = 11:30 IST same day → dayKey 2026-04-24.
    await handler({ scheduledFor: '2026-04-24T06:00:00Z' });

    expect(spy).toHaveBeenCalledTimes(3);
    const tiers = spy.mock.calls.map((c) => (c[0] as ComputeAndPublishInput).tier).sort();
    expect(tiers).toEqual(['PRO', 'PRO_MAX', 'PUBLIC']);
    for (const call of spy.mock.calls) {
      const input = call[0] as ComputeAndPublishInput;
      expect(input.dayKey).toBe('2026-04-24');
      expect(input.yesterdayDayKey).toBe('2026-04-23');
    }
  });

  it('returns perTier array containing all three results when all succeed', async () => {
    const { service } = fakeService(async (input) =>
      fakeResult({
        tier: input.tier,
        voteCount: input.tier === 'PUBLIC' ? 5 : input.tier === 'PRO' ? 3 : 2,
        totalPoolPaise: input.tier === 'PUBLIC' ? 500 : input.tier === 'PRO' ? 1500 : 2000,
      }),
    );
    const handler = createPrizePoolHandler({ service });

    const result = await handler({ scheduledFor: '2026-04-24T06:00:00Z' });
    expect(result.perTier).toHaveLength(3);
    const totals = result.perTier
      .map((p) => ({ tier: p.tier, total: p.totalPoolPaise }))
      .sort((a, b) => a.tier.localeCompare(b.tier));
    expect(totals).toEqual([
      { tier: 'PRO', total: 1500 },
      { tier: 'PRO_MAX', total: 2000 },
      { tier: 'PUBLIC', total: 500 },
    ]);
  });

  it('one tier rejecting → handler throws aggregate; other tiers still attempted', async () => {
    const seen: Tier[] = [];
    const { service } = fakeService(async (input) => {
      seen.push(input.tier);
      if (input.tier === 'PRO') throw new Error('mongo down for PRO');
      return fakeResult({ tier: input.tier });
    });
    const handler = createPrizePoolHandler({ service });

    await expect(handler({ scheduledFor: '2026-04-24T06:00:00Z' })).rejects.toThrow(
      /1\/3 tiers failed.*PRO/,
    );

    // All three were attempted (Promise.allSettled); PRO threw.
    expect(seen.sort()).toEqual(['PRO', 'PRO_MAX', 'PUBLIC']);
  });

  it('all three tiers rejecting → handler throws aggregate listing all', async () => {
    const { service } = fakeService(async () => {
      throw new Error('full outage');
    });
    const handler = createPrizePoolHandler({ service });

    await expect(handler({ scheduledFor: '2026-04-24T06:00:00Z' })).rejects.toThrow(
      /3\/3 tiers failed.*PUBLIC.*PRO.*PRO_MAX/,
    );
  });
});
