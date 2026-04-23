import {
  reconcileCopiedCodes,
  type ReconcileCopiedCodesResult,
} from '../modules/redeem-codes/redeem-codes.reconcile.js';

export interface ReconcileCodesJobData {
  /** ISO-8601 instant. Derived from `job.timestamp` in prod. */
  scheduledFor: string;
}

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

export interface ReconcileCodesHandlerDeps {
  reconcile?: typeof reconcileCopiedCodes;
  cutoffMs?: number;
}

/**
 * Flips `COPIED` redeem codes older than `cutoffMs` (default 24h)
 * to `CLAIMED`. Called hourly via the BullMQ `cron` queue.
 * Convergent: the underlying update predicate only touches rows
 * whose `firstCopiedAt ≤ now − cutoff`, so repeated invocations
 * with the same `scheduledFor` are harmless.
 */
export function createReconcileCodesHandler(
  deps: ReconcileCodesHandlerDeps = {},
): (data: ReconcileCodesJobData) => Promise<ReconcileCopiedCodesResult> {
  const reconcile = deps.reconcile ?? reconcileCopiedCodes;
  const cutoffMs = deps.cutoffMs ?? TWENTY_FOUR_HOURS_MS;
  return async (data: ReconcileCodesJobData): Promise<ReconcileCopiedCodesResult> => {
    const now = new Date(data.scheduledFor);
    return reconcile({ now, cutoffMs });
  };
}
