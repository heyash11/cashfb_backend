import { UserModel } from '../../shared/models/User.model.js';
import { buildSweepFilterPipelineExpr } from './_subscriptions.pipelines.js';

export interface SweepInput {
  clock?: () => Date;
  /** Caps single-call work so a cron tick can't drag on. Default 500. */
  batchSize?: number;
}

export interface SweepResult {
  sweptCount: number;
}

const DEFAULT_BATCH_SIZE = 500;

/**
 * Tier-expiry sweep (Phase 11.3 multi-sub aware; Phase 11.5
 * simplification dropped the legacy tier/tierExpiresAt
 * derivation step).
 *
 * Walks users that have ANY entry in `subscriptions[]` whose
 * `expiresAt < now`, then runs an aggregation pipeline updateMany
 * that `$filter`s subscriptions[] to keep only entries with
 * `expiresAt == null` OR `expiresAt >= now`. The legacy User.tier
 * + tierExpiresAt fields don't exist anymore (Phase 11.5 deletion);
 * /me derives a display-only `currentTier` from the array on read.
 *
 * Race-safe properties:
 *   R6 — if a concurrent `onCharged` extends an entry's expiresAt
 *        between the candidate scan and pipeline write, the
 *        `$filter` cond evaluates against the doc as it's read for
 *        the update. Extended-expiry entries no longer match
 *        `expiresAt < now` and are kept.
 *   R8 — anomaly users (legacy `tier='PRO'` + empty subscriptions[]
 *        from Phase 11.0 backfill — those legacy fields are now
 *        gone too) have NO entries with `expiresAt < now`, so the
 *        candidate scan skips them. Untouched.
 *   Concurrent sweep + sweep — same convergent-state property as
 *   the prior sweep: the second tick's filter excludes entries the
 *   first tick already removed.
 */
export async function sweepExpiredTiers(input: SweepInput = {}): Promise<SweepResult> {
  const clock = input.clock ?? (() => new Date());
  const now = clock();
  const batchSize = Math.max(1, Math.min(10_000, input.batchSize ?? DEFAULT_BATCH_SIZE));

  const candidates = await UserModel.find({
    subscriptions: {
      $elemMatch: {
        expiresAt: { $lt: now, $exists: true, $ne: null },
      },
    },
  })
    .select({ _id: 1 })
    .limit(batchSize)
    .lean<Array<{ _id: unknown }>>()
    .exec();

  if (candidates.length === 0) return { sweptCount: 0 };

  const ids = candidates.map((c) => c._id);
  const result = await UserModel.updateMany({ _id: { $in: ids } }, [
    {
      $set: {
        subscriptions: buildSweepFilterPipelineExpr({ nowRef: { $literal: now } }),
      },
    },
  ]);

  return { sweptCount: result.modifiedCount };
}
