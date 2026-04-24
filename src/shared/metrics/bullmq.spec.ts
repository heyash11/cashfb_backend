import { beforeEach, describe, expect, it, vi } from 'vitest';
import { collectBullmqDepthOnce } from './bullmq.js';
import { bullmqQueueDepth, registry } from './registry.js';

/**
 * Phase 9 Chunk 3 — BullMQ depth poll. Per sign-off we verify the
 * unit contract without booting real Redis: getJobCounts is called
 * once per registered queue, counts map to gauge labels correctly,
 * and missing states render as explicit zero (not absent).
 */
describe('collectBullmqDepthOnce', () => {
  beforeEach(() => {
    bullmqQueueDepth.reset();
  });

  it('calls getJobCounts on every registered queue and maps states to labels', async () => {
    const fakeCounts: Record<string, Record<string, number>> = {
      cron: { waiting: 3, active: 1, delayed: 0, failed: 2 },
      invoice: { waiting: 5, active: 2, delayed: 1, failed: 0 },
      'webhook-retry': { waiting: 0, active: 0, delayed: 0, failed: 0 },
      dlq: { waiting: 7, active: 0, delayed: 0, failed: 0 },
    };
    const getCounts = vi.fn(async (name: string) => fakeCounts[name] ?? {});

    await collectBullmqDepthOnce(getCounts);

    expect(getCounts).toHaveBeenCalledTimes(4);
    expect(getCounts).toHaveBeenCalledWith('cron');
    expect(getCounts).toHaveBeenCalledWith('invoice');
    expect(getCounts).toHaveBeenCalledWith('webhook-retry');
    expect(getCounts).toHaveBeenCalledWith('dlq');

    const text = await registry.metrics();
    expect(text).toMatch(/bullmq_queue_depth\{queue="cron",state="waiting"\} 3/);
    expect(text).toMatch(/bullmq_queue_depth\{queue="cron",state="active"\} 1/);
    expect(text).toMatch(/bullmq_queue_depth\{queue="cron",state="failed"\} 2/);
    expect(text).toMatch(/bullmq_queue_depth\{queue="invoice",state="waiting"\} 5/);
    expect(text).toMatch(/bullmq_queue_depth\{queue="dlq",state="waiting"\} 7/);
  });

  it('emits explicit zero when a state is missing from the counts response', async () => {
    // getJobCounts returns a partial object — we must still write
    // 0 to every {queue,state} pair so Prometheus can ALERT on
    // absent() without misfiring on empty-but-present queues.
    const getCounts = vi.fn(async () => ({ waiting: 4 }));
    await collectBullmqDepthOnce(getCounts);

    const text = await registry.metrics();
    expect(text).toMatch(/bullmq_queue_depth\{queue="cron",state="waiting"\} 4/);
    expect(text).toMatch(/bullmq_queue_depth\{queue="cron",state="active"\} 0/);
    expect(text).toMatch(/bullmq_queue_depth\{queue="cron",state="delayed"\} 0/);
    expect(text).toMatch(/bullmq_queue_depth\{queue="cron",state="failed"\} 0/);
  });

  it('swallows per-queue errors without aborting the loop', async () => {
    const getCounts = vi.fn(async (name: string) => {
      if (name === 'invoice') throw new Error('redis down');
      return { waiting: 1, active: 0, delayed: 0, failed: 0 };
    });

    await expect(collectBullmqDepthOnce(getCounts)).resolves.toBeUndefined();
    expect(getCounts).toHaveBeenCalledTimes(4);

    const text = await registry.metrics();
    // other queues still populated
    expect(text).toMatch(/bullmq_queue_depth\{queue="cron",state="waiting"\} 1/);
    expect(text).toMatch(/bullmq_queue_depth\{queue="dlq",state="waiting"\} 1/);
  });
});
