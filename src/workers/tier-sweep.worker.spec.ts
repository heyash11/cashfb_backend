import { describe, expect, it, vi } from 'vitest';
import { createTierSweepHandler, type TierSweepJobData } from './tier-sweep.worker.js';

describe('tier-sweep worker handler', () => {
  it('forwards clock = scheduledFor and batchSize to sweepExpiredTiers', async () => {
    const sweep = vi.fn().mockResolvedValue({ sweptCount: 3 });
    const handler = createTierSweepHandler({ sweep });

    await handler({ scheduledFor: '2026-04-24T02:00:00Z', batchSize: 500 });

    expect(sweep).toHaveBeenCalledTimes(1);
    const [arg] = sweep.mock.calls[0] ?? [];
    const a = arg as { clock: () => Date; batchSize: number };
    expect(a.batchSize).toBe(500);
    expect(a.clock().toISOString()).toBe('2026-04-24T02:00:00.000Z');
  });

  it('does NOT re-enqueue when sweptCount < batchSize', async () => {
    const sweep = vi.fn().mockResolvedValue({ sweptCount: 42 });
    const enqueue = vi.fn<(data: TierSweepJobData) => Promise<void>>(async () => undefined);
    const handler = createTierSweepHandler({ sweep, enqueueContinuation: enqueue });

    const result = await handler({ scheduledFor: '2026-04-24T02:00:00Z', batchSize: 500 });

    expect(enqueue).not.toHaveBeenCalled();
    expect(result).toEqual({ sweptCount: 42, reEnqueued: false });
  });

  it('self-re-enqueues a continuation job when sweptCount === batchSize', async () => {
    const sweep = vi.fn().mockResolvedValue({ sweptCount: 500 });
    const enqueue = vi.fn<(data: TierSweepJobData) => Promise<void>>(async () => undefined);
    const handler = createTierSweepHandler({ sweep, enqueueContinuation: enqueue });

    const result = await handler({ scheduledFor: '2026-04-24T02:00:00Z', batchSize: 500 });

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith({
      scheduledFor: '2026-04-24T02:00:00Z',
      batchSize: 500,
      continuation: true,
    });
    expect(result).toEqual({ sweptCount: 500, reEnqueued: true });
  });

  it('propagates sweep errors', async () => {
    const sweep = vi.fn().mockRejectedValue(new Error('mongo down'));
    const handler = createTierSweepHandler({ sweep });

    await expect(handler({ scheduledFor: '2026-04-24T02:00:00Z' })).rejects.toThrow('mongo down');
  });
});
