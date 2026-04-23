import { describe, expect, it, vi } from 'vitest';
import type {
  ComputeAndPublishInput,
  ComputeAndPublishResult,
  PrizePoolService,
} from '../modules/prize-pools/prize-pools.service.js';
import { createPrizePoolHandler } from './prize-pool.worker.js';

function fakeService(impl?: (input: ComputeAndPublishInput) => Promise<ComputeAndPublishResult>): {
  service: PrizePoolService;
  spy: ReturnType<typeof vi.fn>;
} {
  const spy = vi.fn(
    impl ??
      (async () =>
        ({
          created: true,
          yesterdayVoteCount: 0,
          baseRatePaise: 100,
          totalPoolPaise: 0,
          giftCodeBudgetPaise: 0,
          customRoomBudgetPaise: 0,
        }) satisfies ComputeAndPublishResult),
  );
  return { service: { computeAndPublishPool: spy } as unknown as PrizePoolService, spy };
}

describe('prize-pool worker handler', () => {
  it('derives dayKey + yesterdayDayKey from scheduledFor in IST and forwards to the service', async () => {
    const { service, spy } = fakeService();
    const handler = createPrizePoolHandler({ service });

    // 06:00 UTC on 2026-04-24 = 11:30 IST same day → dayKey 2026-04-24.
    await handler({ scheduledFor: '2026-04-24T06:00:00Z' });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({
      dayKey: '2026-04-24',
      yesterdayDayKey: '2026-04-23',
    });
  });

  it('returns the service result verbatim (deterministic re-run semantics propagate up)', async () => {
    const { service } = fakeService(async () => ({
      created: false,
      yesterdayVoteCount: 100,
      baseRatePaise: 100,
      totalPoolPaise: 10_000,
      giftCodeBudgetPaise: 7_000,
      customRoomBudgetPaise: 3_000,
    }));
    const handler = createPrizePoolHandler({ service });

    const result = await handler({ scheduledFor: '2026-04-24T06:00:00Z' });
    expect(result).toEqual({
      created: false,
      yesterdayVoteCount: 100,
      baseRatePaise: 100,
      totalPoolPaise: 10_000,
      giftCodeBudgetPaise: 7_000,
      customRoomBudgetPaise: 3_000,
    });
  });

  it('propagates service errors so BullMQ records a failure attempt', async () => {
    const { service } = fakeService(async () => {
      throw new Error('mongo down');
    });
    const handler = createPrizePoolHandler({ service });

    await expect(handler({ scheduledFor: '2026-04-24T06:00:00Z' })).rejects.toThrow('mongo down');
  });
});
