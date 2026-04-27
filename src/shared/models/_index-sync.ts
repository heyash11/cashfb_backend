import type { Model } from 'mongoose';
import { logger } from '../../config/logger.js';

/**
 * Boot-time index synchronisation for Phase 11.0+ (parallel tier
 * model). Gated behind `MONGO_SYNC_INDEXES_ON_BOOT=true` because
 * `syncIndexes()` mutates index state — we don't want it to fire
 * on every prod boot, only on the first boot of a release that
 * carries an index change.
 *
 * Mongoose's `syncIndexes()` walks the schema's declared indexes,
 * creates any that don't yet exist, then drops indexes present in
 * MongoDB that the schema no longer declares. Critically, it adds
 * BEFORE it removes — so a unique-index swap (Vote {userId,dayKey}
 * → {userId,tier,dayKey}; PrizePool {dayKey} → {tier,dayKey}) goes
 * through a transient state where both indexes are enforced. That
 * window is strictly stricter than either before or after, so no
 * uniqueness gap can open during the swap.
 *
 * Operator workflow for a release that changes indexes:
 *   1. Ship the new schema + this helper.
 *   2. Set `MONGO_SYNC_INDEXES_ON_BOOT=true` in the env.
 *   3. Roll the new version.
 *   4. After the first boot logs `[index-sync] complete`, unset
 *      the flag for subsequent reboots.
 */
export async function syncIndexesIfEnabled(
  models: ReadonlyArray<Pick<Model<unknown>, 'modelName' | 'syncIndexes'>>,
  enabled: boolean,
): Promise<void> {
  if (!enabled) return;
  logger.info({ modelCount: models.length }, '[index-sync] starting');
  for (const model of models) {
    try {
      const dropped = await model.syncIndexes();
      logger.info({ model: model.modelName, dropped }, `[index-sync] ${model.modelName} synced`);
    } catch (err) {
      logger.error({ err, model: model.modelName }, `[index-sync] ${model.modelName} FAILED`);
      throw err;
    }
  }
  logger.info('[index-sync] complete');
}
