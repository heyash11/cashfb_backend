import { logger } from '../../config/logger.js';
import { UserModel } from '../../shared/models/User.model.js';

export interface Phase115BackfillReport {
  scanned: number;
  tokenVersionAdded: number;
  legacyDropped: number;
}

/**
 * Phase 11.5 — drop legacy single-tier fields from users + ensure
 * tokenVersion is present.
 *
 * Single aggregation-pipeline updateMany over the entire collection:
 *   - $set tokenVersion: $ifNull($tokenVersion, 1)  (idempotent)
 *   - $unset tier, tierExpiresAt, activeSubscriptionId
 *
 * Re-runnable. Reports counts.
 *
 * Operator workflow (one-shot at deploy):
 *   1. Roll new app/worker images.
 *   2. Run scripts/backfill-phase-11-5.ts → drops legacy fields,
 *      adds tokenVersion to existing rows.
 *   3. Run scripts/bump-token-versions.ts → invalidates all
 *      existing tokens (every user redirected to login).
 */
export async function runPhase115Backfill(): Promise<Phase115BackfillReport> {
  // Use the collection-level driver so the legacy field $unset
  // works regardless of Mongoose's schema-strictness mode.
  const total = await UserModel.collection.countDocuments({});
  const needsTokenVersion = await UserModel.collection.countDocuments({
    tokenVersion: { $exists: false },
  });
  const hasLegacy = await UserModel.collection.countDocuments({
    $or: [
      { tier: { $exists: true } },
      { tierExpiresAt: { $exists: true } },
      { activeSubscriptionId: { $exists: true } },
    ],
  });

  if (needsTokenVersion === 0 && hasLegacy === 0) {
    const report: Phase115BackfillReport = {
      scanned: total,
      tokenVersionAdded: 0,
      legacyDropped: 0,
    };
    logger.info(report, '[backfill:phase-11-5] complete (no-op)');
    return report;
  }

  await UserModel.collection.updateMany({}, [
    {
      $set: {
        tokenVersion: { $ifNull: ['$tokenVersion', 1] },
      },
    },
    {
      $unset: ['tier', 'tierExpiresAt', 'activeSubscriptionId'],
    },
  ]);

  const report: Phase115BackfillReport = {
    scanned: total,
    tokenVersionAdded: needsTokenVersion,
    legacyDropped: hasLegacy,
  };
  logger.info(report, '[backfill:phase-11-5] complete');
  return report;
}

/**
 * Phase 11.5 — bump every user's `tokenVersion` by 1. Invalidates
 * every existing JWT (next request → TOKEN_VERSION_MISMATCH 401 →
 * user redirected to login).
 *
 * Idempotent in the sense of "running twice just shifts the cutoff
 * one more step." Each run produces a unique invalidation event.
 *
 * Operator workflow: see `runPhase115Backfill` JSDoc — bump runs
 * AFTER the field-drop migration so all rows already have a
 * tokenVersion to increment.
 */
export interface BumpTokenVersionsReport {
  matched: number;
  modified: number;
}

export async function runBumpTokenVersions(): Promise<BumpTokenVersionsReport> {
  const result = await UserModel.collection.updateMany({}, { $inc: { tokenVersion: 1 } });
  const report: BumpTokenVersionsReport = {
    matched: result.matchedCount,
    modified: result.modifiedCount,
  };
  logger.info(report, '[bump-token-versions] complete');
  return report;
}
