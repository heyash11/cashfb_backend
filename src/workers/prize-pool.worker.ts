import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone.js';
import utc from 'dayjs/plugin/utc.js';
import { logger } from '../config/logger.js';
import {
  PrizePoolService,
  type ComputeAndPublishResult,
} from '../modules/prize-pools/prize-pools.service.js';
import { TIER_VALUES, type Tier } from '../shared/models/_tier.js';
import { dayKeyIst } from '../shared/utils/date.js';

dayjs.extend(utc);
dayjs.extend(timezone);

export interface PrizePoolJobData {
  /**
   * ISO-8601 instant representing when this cron fire "is for". In
   * prod the top-level router derives this from `job.timestamp`
   * (BullMQ fire time) at the moment the worker picks up the job.
   * Tests fabricate it explicitly — consistent with the Phase 6
   * clock-injection pattern.
   */
  scheduledFor: string;
}

export interface PrizePoolHandlerDeps {
  service?: PrizePoolService;
}

/**
 * Phase 11.2 — fanout shape. The handler runs three computations
 * in parallel via `Promise.allSettled`. If ANY tier rejects, the
 * handler logs each failure and throws an aggregate error so
 * BullMQ retries the whole job. Idempotency makes the retry safe:
 * already-materialized rows return `created:false` on the second
 * pass; only the failed tier gets a fresh attempt.
 */
export interface PrizePoolFanoutResult {
  perTier: ComputeAndPublishResult[];
}

function yesterdayDayKeyIst(scheduledFor: Date): string {
  return dayjs(scheduledFor).tz('Asia/Kolkata').subtract(1, 'day').format('YYYY-MM-DD');
}

export function createPrizePoolHandler(
  deps: PrizePoolHandlerDeps = {},
): (data: PrizePoolJobData) => Promise<PrizePoolFanoutResult> {
  const service = deps.service ?? new PrizePoolService();
  return async (data: PrizePoolJobData): Promise<PrizePoolFanoutResult> => {
    const scheduledFor = new Date(data.scheduledFor);
    const dayKey = dayKeyIst(scheduledFor);
    const yesterdayDayKey = yesterdayDayKeyIst(scheduledFor);

    const settled = await Promise.allSettled(
      TIER_VALUES.map((tier: Tier) =>
        service.computeAndPublishPool({ dayKey, yesterdayDayKey, tier }),
      ),
    );

    const perTier: ComputeAndPublishResult[] = [];
    const failures: { tier: Tier; reason: unknown }[] = [];
    settled.forEach((result, idx) => {
      const tier = TIER_VALUES[idx]!;
      if (result.status === 'fulfilled') {
        perTier.push(result.value);
      } else {
        failures.push({ tier, reason: result.reason });
        logger.error(
          { err: result.reason, tier, dayKey, yesterdayDayKey },
          '[prize-pool] tier compute failed',
        );
      }
    });

    if (failures.length > 0) {
      throw new Error(
        `prize-pool fanout: ${failures.length}/${TIER_VALUES.length} tiers failed (` +
          `${failures.map((f) => f.tier).join(',')})`,
      );
    }

    return { perTier };
  };
}
