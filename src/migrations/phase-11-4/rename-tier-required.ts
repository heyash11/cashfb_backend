import type { Model } from 'mongoose';
import { logger } from '../../config/logger.js';
import { CustomRoomModel } from '../../shared/models/CustomRoom.model.js';
import { PostModel } from '../../shared/models/Post.model.js';

export interface RenameTierReport {
  collection: string;
  scanned: number;
  updated: number;
  skipped: number;
}

/**
 * Phase 11.4 — rename `tierRequired` → `tier` on the `posts` and
 * `custom_rooms` collections. Atomic per document via aggregation
 * pipeline updateMany: copy `tierRequired` into `tier`, then unset
 * `tierRequired`.
 *
 * Idempotent. Filtered on `{ tier: { $exists: false } }`, so a
 * re-run reports zero updates. Documents that already have `tier`
 * set (from new code post-deploy) are untouched.
 */
async function renameForCollection<T>(
  model: Model<T>,
  collectionName: string,
): Promise<RenameTierReport> {
  // We're operating against the legacy field name which the new
  // schema doesn't declare; fall through Mongoose's strict mode by
  // hitting the underlying collection driver directly.
  const filter = { tier: { $exists: false }, tierRequired: { $exists: true } };
  const scanned = await model.collection.countDocuments(filter);

  if (scanned === 0) {
    const report: RenameTierReport = {
      collection: collectionName,
      scanned: 0,
      updated: 0,
      skipped: 0,
    };
    logger.info(report, `[backfill:phase-11-4:${collectionName}] complete (no-op)`);
    return report;
  }

  const result = await model.collection.updateMany(filter, [
    { $set: { tier: '$tierRequired' } },
    { $unset: 'tierRequired' },
  ]);

  const report: RenameTierReport = {
    collection: collectionName,
    scanned,
    updated: result.modifiedCount,
    skipped: scanned - result.modifiedCount,
  };
  logger.info(report, `[backfill:phase-11-4:${collectionName}] complete`);
  return report;
}

export async function runRenamePostTier(): Promise<RenameTierReport> {
  return renameForCollection(PostModel, 'posts');
}

export async function runRenameCustomRoomTier(): Promise<RenameTierReport> {
  return renameForCollection(CustomRoomModel, 'custom_rooms');
}
