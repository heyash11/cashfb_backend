import { logger } from '../../config/logger.js';
import { AppConfigModel } from '../../shared/models/AppConfig.model.js';

/**
 * Phase 11.6 — DEV-ONLY operator helper. Flips
 * `app_config.featureFlags.tournaments` to `true` on the canonical
 * `{key: 'default'}` row. Idempotent.
 *
 * **DO NOT RUN AGAINST PRODUCTION** until the project owner confirms
 * legal sign-off on PROGA 2025 implications (CLAUDE.md §0.1).
 * Tournaments + paid-access gift-card contests are the two features
 * the act may classify as prohibited "online money games"; the flag
 * defaults to `false` to keep that path dark in prod.
 *
 * Caller is responsible for `mongoose.connect(uri)` before and
 * `mongoose.disconnect()` after — the operator script
 * (`scripts/enable-tournaments-dev.ts`) drives the lifecycle so
 * callers from inside an already-connected process (e.g. tests) can
 * call this directly.
 */
export interface EnableTournamentsReport {
  matched: number;
  modified: number;
  upserted: boolean;
}

export async function runEnableTournamentsDev(): Promise<EnableTournamentsReport> {
  const result = await AppConfigModel.updateOne(
    { key: 'default' },
    { $set: { 'featureFlags.tournaments': true }, $setOnInsert: { key: 'default' } },
    { upsert: true },
  );
  const report: EnableTournamentsReport = {
    matched: result.matchedCount,
    modified: result.modifiedCount,
    upserted: result.upsertedCount > 0,
  };
  logger.info(report, '[enable-tournaments-dev] complete');
  return report;
}
