import { sweepExpiredTiers, type SweepResult } from '../modules/subscriptions/sweep.service.js';

export interface TierSweepJobData {
  scheduledFor: string;
  batchSize?: number;
  /** Set by the handler when it self-re-enqueues to drain a backlog.
   *  Purely informational for log correlation — the sweep logic is
   *  identical for cron fires and continuation jobs. */
  continuation?: boolean;
}

const DEFAULT_BATCH_SIZE = 500;

export interface TierSweepHandlerResult extends SweepResult {
  reEnqueued: boolean;
}

export interface TierSweepHandlerDeps {
  sweep?: typeof sweepExpiredTiers;
  /** Invoked when `sweptCount === batchSize` so the next batch is
   *  drained immediately rather than waiting 24 h for the next
   *  scheduled cron fire. Default calls `getQueue(CRON).add(...)`
   *  with a descriptive jobId; tests inject a spy. */
  enqueueContinuation?: (data: TierSweepJobData) => Promise<void>;
}

export function createTierSweepHandler(
  deps: TierSweepHandlerDeps = {},
): (data: TierSweepJobData) => Promise<TierSweepHandlerResult> {
  const sweep = deps.sweep ?? sweepExpiredTiers;
  const enqueueContinuation = deps.enqueueContinuation;

  return async (data: TierSweepJobData): Promise<TierSweepHandlerResult> => {
    const now = new Date(data.scheduledFor);
    const batchSize = data.batchSize ?? DEFAULT_BATCH_SIZE;
    const result = await sweep({ clock: () => now, batchSize });

    let reEnqueued = false;
    if (result.sweptCount === batchSize && enqueueContinuation) {
      await enqueueContinuation({
        scheduledFor: data.scheduledFor,
        batchSize,
        continuation: true,
      });
      reEnqueued = true;
    }

    return { ...result, reEnqueued };
  };
}
