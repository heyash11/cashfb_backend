import { RedeemCodeModel } from '../../shared/models/RedeemCode.model.js';

export interface ReconcileCopiedCodesInput {
  /** Injected clock. Tests pass a fixed Date; the Phase 7 cron passes `new Date()`. */
  now: Date;
  /** Milliseconds a code may stay COPIED before auto-flip. Default 24h. */
  cutoffMs?: number;
}

export interface ReconcileCopiedCodesResult {
  reconciled: number;
}

const DEFAULT_CUTOFF_MS = 24 * 60 * 60 * 1000;

/**
 * Flip every `COPIED` code whose `firstCopiedAt` is older than the
 * cutoff to `CLAIMED`, assigning `claimedBy = firstCopiedBy` and
 * `claimedAt = now`. A code stuck in `COPIED` means the user
 * forgot to self-declare via `markClaimed`; after 24h we assume
 * they redeemed on Play and close the state.
 *
 * Phase 7 wires this as a BullMQ job `redeem-code-reconcile`
 * running hourly. The `now` + `cutoffMs` injection keeps this a
 * pure function against Mongo state — no wall-clock coupling — so
 * the 24h cutoff is test-observable.
 *
 * Callable directly for admin force-reconciles if ever needed.
 */
export async function reconcileCopiedCodes(
  input: ReconcileCopiedCodesInput,
): Promise<ReconcileCopiedCodesResult> {
  const cutoffMs = input.cutoffMs ?? DEFAULT_CUTOFF_MS;
  const threshold = new Date(input.now.getTime() - cutoffMs);

  const stuck = await RedeemCodeModel.find({
    status: 'COPIED',
    firstCopiedAt: { $lte: threshold },
  })
    .select({ _id: 1, firstCopiedBy: 1 })
    .lean()
    .exec();

  let reconciled = 0;
  for (const row of stuck) {
    if (!row.firstCopiedBy) continue;
    const res = await RedeemCodeModel.updateOne(
      { _id: row._id, status: 'COPIED' },
      {
        $set: {
          status: 'CLAIMED',
          claimedBy: row.firstCopiedBy,
          claimedAt: input.now,
        },
      },
    );
    if (res.modifiedCount === 1) reconciled += 1;
  }

  return { reconciled };
}
