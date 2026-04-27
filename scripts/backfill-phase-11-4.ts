import mongoose from 'mongoose';
import { z } from 'zod';
import { logger } from '../src/config/logger.js';
import {
  runRenameCustomRoomTier,
  runRenamePostTier,
} from '../src/migrations/phase-11-4/rename-tier-required.js';

/**
 * Phase 11.4 backfill entry-point. Renames `tierRequired` → `tier`
 * on `posts` and `custom_rooms` via aggregation-pipeline updateMany.
 * Idempotent.
 *
 * Usage:
 *   pnpm tsx scripts/backfill-phase-11-4.ts
 *
 * Re-running prints {scanned: 0, updated: 0, skipped: 0} for each
 * collection once the migration has been applied.
 *
 * The new compound indexes ({tier,dayKey,status,scheduledAt} on
 * posts; {tier,dayKey,game,scheduledAt} on custom_rooms) land via
 * the existing MONGO_SYNC_INDEXES_ON_BOOT path from Phase 11.0.
 * Operator workflow:
 *   1. Set MONGO_SYNC_INDEXES_ON_BOOT=true.
 *   2. Roll new app + worker images.
 *   3. Watch logs for `[index-sync] complete`.
 *   4. Run this script once.
 *   5. Unset the env flag.
 */

const EnvSchema = z.object({
  MONGO_URI: z.string().min(1),
});

async function main(): Promise<void> {
  const env = EnvSchema.parse(process.env);
  await mongoose.connect(env.MONGO_URI);
  logger.info('[backfill:phase-11-4] mongo connected');

  try {
    const postReport = await runRenamePostTier();
    const roomReport = await runRenameCustomRoomTier();
    logger.info(
      { posts: postReport, customRooms: roomReport },
      '[backfill:phase-11-4] all migrations complete',
    );
  } finally {
    await mongoose.disconnect();
    logger.info('[backfill:phase-11-4] mongo disconnected');
  }
}

main().catch((err: unknown) => {
  logger.error({ err }, '[backfill:phase-11-4] FATAL');
  process.exit(1);
});
