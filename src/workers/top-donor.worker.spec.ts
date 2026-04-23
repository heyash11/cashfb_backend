import { describe, expect, it, vi } from 'vitest';
import type { DonationService } from '../modules/donations/donations.service.js';
import { createTopDonorHandler } from './top-donor.worker.js';

function fakeService(result = { rankingCount: 0 }) {
  const spy = vi.fn().mockResolvedValue(result);
  return { service: { refreshTopDonorRanking: spy } as unknown as DonationService, spy };
}

describe('top-donor worker handler', () => {
  it('calls refreshTopDonorRanking with default limit 50', async () => {
    const { service, spy } = fakeService();
    const handler = createTopDonorHandler({ service });

    await handler({ scheduledFor: '2026-04-24T10:00:00Z' });

    expect(spy).toHaveBeenCalledWith({ limit: 50 });
  });

  it('respects explicit limit from job data', async () => {
    const { service, spy } = fakeService();
    const handler = createTopDonorHandler({ service });

    await handler({ scheduledFor: '2026-04-24T10:00:00Z', limit: 10 });

    expect(spy).toHaveBeenCalledWith({ limit: 10 });
  });

  it('propagates errors', async () => {
    const spy = vi.fn().mockRejectedValue(new Error('aggregation failed'));
    const handler = createTopDonorHandler({
      service: { refreshTopDonorRanking: spy } as unknown as DonationService,
    });

    await expect(handler({ scheduledFor: '2026-04-24T10:00:00Z' })).rejects.toThrow(
      'aggregation failed',
    );
  });
});
