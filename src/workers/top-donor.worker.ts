import { DonationService } from '../modules/donations/donations.service.js';

export interface TopDonorJobData {
  /** ISO-8601 instant — present for symmetry with other cron
   *  handlers; this handler doesn't actually need it since the
   *  aggregation is over the full donation history. Kept for
   *  future time-window extensions. */
  scheduledFor: string;
  limit?: number;
}

const DEFAULT_LIMIT = 50;

export interface TopDonorHandlerDeps {
  service?: DonationService;
}

export function createTopDonorHandler(
  deps: TopDonorHandlerDeps = {},
): (data: TopDonorJobData) => Promise<{ rankingCount: number }> {
  const service = deps.service ?? new DonationService();
  return async (data: TopDonorJobData): Promise<{ rankingCount: number }> => {
    return service.refreshTopDonorRanking({ limit: data.limit ?? DEFAULT_LIMIT });
  };
}
