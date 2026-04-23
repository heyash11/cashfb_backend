import { describe, expect, it, vi } from 'vitest';
import { createReconcileCodesHandler } from './reconcile-codes.worker.js';

describe('reconcile-codes worker handler', () => {
  it('invokes reconcileCopiedCodes with now = new Date(scheduledFor) and cutoffMs = 24h', async () => {
    const spy = vi.fn().mockResolvedValue({ reconciled: 0 });
    const handler = createReconcileCodesHandler({ reconcile: spy });

    await handler({ scheduledFor: '2026-04-24T10:00:00Z' });

    expect(spy).toHaveBeenCalledTimes(1);
    const [arg] = spy.mock.calls[0] ?? [];
    expect((arg as { now: Date }).now.toISOString()).toBe('2026-04-24T10:00:00.000Z');
    expect((arg as { cutoffMs: number }).cutoffMs).toBe(24 * 60 * 60 * 1000);
  });

  it('returns the reconcile result verbatim', async () => {
    const spy = vi.fn().mockResolvedValue({ reconciled: 7 });
    const handler = createReconcileCodesHandler({ reconcile: spy });

    const result = await handler({ scheduledFor: '2026-04-24T10:00:00Z' });
    expect(result).toEqual({ reconciled: 7 });
  });

  it('propagates errors to the caller (BullMQ records the failure)', async () => {
    const spy = vi.fn().mockRejectedValue(new Error('reconcile blew up'));
    const handler = createReconcileCodesHandler({ reconcile: spy });

    await expect(handler({ scheduledFor: '2026-04-24T10:00:00Z' })).rejects.toThrow(
      'reconcile blew up',
    );
  });
});
