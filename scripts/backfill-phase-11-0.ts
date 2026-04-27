import mongoose from 'mongoose';
import { z } from 'zod';
import { logger } from '../src/config/logger.js';
import { runBackfillPrizePoolTier } from '../src/migrations/phase-11-0/backfill-prize-pool-tier.js';
import { runBackfillRedeemCodeTier } from '../src/migrations/phase-11-0/backfill-redeem-code-tier.js';
import { runBackfillUserSubscriptions } from '../src/migrations/phase-11-0/backfill-user-subscriptions.js';
import { runBackfillVoteTier } from '../src/migrations/phase-11-0/backfill-vote-tier.js';

/**
 * Phase 11.0 backfill entry-point. Runs the four schema-additive
 * migrations in order:
 *   1) Vote.tier            (default 'PUBLIC')
 *   2) PrizePool.tier       (default 'PUBLIC')
 *   3) RedeemCode.tier      ($lookup parent Post.tierRequired)
 *   4) User.subscriptions[] (translate legacy tier + activeSubId)
 *
 * Usage:
 *   pnpm tsx scripts/backfill-phase-11-0.ts
 *
 * Idempotent. Re-running prints {scanned, updated:0, skipped:N} for
 * each migration.
 *
 * The schema-level index swaps (Vote {userId,dayKey} →
 * {userId,tier,dayKey}; PrizePool {dayKey} → {tier,dayKey}) are
 * NOT performed by this script — they happen at app boot when
 * MONGO_SYNC_INDEXES_ON_BOOT=true. Operator workflow:
 *   1. Set MONGO_SYNC_INDEXES_ON_BOOT=true.
 *   2. Roll the new app version (api + worker both run syncIndexes).
 *   3. Watch for `[index-sync] complete` in the boot log.
 *   4. Run this script once.
 *   5. Unset the env flag.
 */

const EnvSchema = z.object({
  MONGO_URI: z.string().min(1),
});

async function main(): Promise<void> {
  const env = EnvSchema.parse(process.env);
  await mongoose.connect(env.MONGO_URI);
  logger.info('[backfill:phase-11-0] mongo connected');

  try {
    const voteReport = await runBackfillVoteTier();
    const poolReport = await runBackfillPrizePoolTier();
    const codeReport = await runBackfillRedeemCodeTier();
    const userReport = await runBackfillUserSubscriptions();

    logger.info(
      {
        votes: voteReport,
        prizePools: poolReport,
        redeemCodes: codeReport,
        userSubscriptions: userReport,
      },
      '[backfill:phase-11-0] all migrations complete',
    );
  } finally {
    await mongoose.disconnect();
    logger.info('[backfill:phase-11-0] mongo disconnected');
  }
}

main().catch((err: unknown) => {
  logger.error({ err }, '[backfill:phase-11-0] FATAL');
  process.exit(1);
});
