import { logger } from '../../config/logger.js';
import { PrizePoolModel } from '../../shared/models/PrizePool.model.js';
import type { BackfillReport } from './backfill-vote-tier.js';

/**
 * Phase 11.0 — backfill `PrizePool.tier`. Pre-migration pools were
 * computed as one row per `dayKey` across all tiers (Phase 10.1's
 * tier-weighted single pool). We default existing rows to
 * `'PUBLIC'` so the new compound unique index `{tier,dayKey}`
 * doesn't conflict with new Phase 11.2 fan-out runs.
 *
 * Idempotent — filtered on `{ tier: { $exists: false } }`.
 */
export async function runBackfillPrizePoolTier(): Promise<BackfillReport> {
  const filter = { tier: { $exists: false } };
  const scanned = await PrizePoolModel.countDocuments(filter);
  const result = await PrizePoolModel.updateMany(filter, { $set: { tier: 'PUBLIC' } });
  const report: BackfillReport = {
    collection: 'prize_pools',
    scanned,
    updated: result.modifiedCount,
    skipped: scanned - result.modifiedCount,
  };
  logger.info(report, '[backfill:prize-pool-tier] complete');
  return report;
}
