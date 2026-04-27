import { logger } from '../../config/logger.js';
import { VoteModel } from '../../shared/models/Vote.model.js';

export interface BackfillReport {
  collection: string;
  scanned: number;
  updated: number;
  skipped: number;
}

/**
 * Phase 11.0 — backfill `Vote.tier`. Pre-migration vote rows lack
 * the `tier` field; we set them all to `'PUBLIC'` since every
 * vote prior to 11.1 was cast in the (single) PUBLIC section.
 *
 * Idempotent: filtered on `{ tier: { $exists: false } }`, so a
 * re-run reports zero updates.
 */
export async function runBackfillVoteTier(): Promise<BackfillReport> {
  const filter = { tier: { $exists: false } };
  const scanned = await VoteModel.countDocuments(filter);
  const result = await VoteModel.updateMany(filter, { $set: { tier: 'PUBLIC' } });
  const report: BackfillReport = {
    collection: 'votes',
    scanned,
    updated: result.modifiedCount,
    skipped: scanned - result.modifiedCount,
  };
  logger.info(report, '[backfill:vote-tier] complete');
  return report;
}
