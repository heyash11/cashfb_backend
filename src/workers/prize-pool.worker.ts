import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone.js';
import utc from 'dayjs/plugin/utc.js';
import {
  PrizePoolService,
  type ComputeAndPublishResult,
} from '../modules/prize-pools/prize-pools.service.js';
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
 * Derive `yesterdayDayKey` from `scheduledFor` in IST. We can't use
 * `new Date(scheduledFor - 24h)` and then `dayKeyIst` — that would
 * return the wrong dayKey across DST-like transitions in principle
 * (India has no DST, but the logic should be timezone-correct).
 * Instead, subtract 1 IST day from the IST-anchored datetime.
 */
function yesterdayDayKeyIst(scheduledFor: Date): string {
  return dayjs(scheduledFor).tz('Asia/Kolkata').subtract(1, 'day').format('YYYY-MM-DD');
}

export function createPrizePoolHandler(
  deps: PrizePoolHandlerDeps = {},
): (data: PrizePoolJobData) => Promise<ComputeAndPublishResult> {
  const service = deps.service ?? new PrizePoolService();
  return async (data: PrizePoolJobData): Promise<ComputeAndPublishResult> => {
    const scheduledFor = new Date(data.scheduledFor);
    const dayKey = dayKeyIst(scheduledFor);
    const yesterdayDayKey = yesterdayDayKeyIst(scheduledFor);
    return service.computeAndPublishPool({ dayKey, yesterdayDayKey });
  };
}
