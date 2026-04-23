import { UserModel } from '../../shared/models/User.model.js';

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
 * Tier-expiry sweep. Flips users whose `tierExpiresAt` is past `now`
 * back to `PUBLIC`. Intended to run as the Phase 7 hourly BullMQ
 * cron; callable directly for admin force-runs.
 *
 * Convergent-state predicate (`tier: {$ne: 'PUBLIC'}`) makes
 * concurrent runs race-safe: a row already flipped to PUBLIC by one
 * worker is excluded from the next worker's filter. Total downgrades
 * across any N parallel runs equal the number of expired rows, not
 * N × rows.
 *
 * Race with a concurrent `subscription.charged` webhook that
 * upgrades a user mid-sweep: the webhook's tier write runs in its
 * own transaction and lands either before or after ours. Worst-case
 * the user's brand-new paid subscription gets downgraded by one
 * sweep tick; the next `charged` webhook (or a re-subscribe) re-
 * upgrades. Per the Phase 6 plan's advisory-predicate verdict this
 * window is seconds per month and acceptable for MVP.
 */
export async function sweepExpiredTiers(input: SweepInput = {}): Promise<SweepResult> {
  const clock = input.clock ?? (() => new Date());
  const now = clock();
  const batchSize = Math.max(1, Math.min(10_000, input.batchSize ?? DEFAULT_BATCH_SIZE));

  // Two-step: select candidate _ids up to the batch cap, then flip
  // with the same predicate so a concurrent sweep can't double-
  // count. Mongo's `updateMany` has no inherent batch cap; this
  // sequence is the cleanest way to bound per-tick work.
  const candidates = await UserModel.find({
    tier: { $ne: 'PUBLIC' },
    tierExpiresAt: { $lt: now, $exists: true },
  })
    .select({ _id: 1 })
    .limit(batchSize)
    .lean<Array<{ _id: unknown }>>()
    .exec();

  if (candidates.length === 0) return { sweptCount: 0 };

  const ids = candidates.map((c) => c._id);
  const result = await UserModel.updateMany(
    {
      _id: { $in: ids },
      tier: { $ne: 'PUBLIC' },
      tierExpiresAt: { $lt: now, $exists: true },
    },
    { $set: { tier: 'PUBLIC', tierExpiresAt: null } },
  );

  return { sweptCount: result.modifiedCount };
}
