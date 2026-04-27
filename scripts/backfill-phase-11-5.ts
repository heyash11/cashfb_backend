import mongoose from 'mongoose';
import { z } from 'zod';
import { logger } from '../src/config/logger.js';
import { runPhase115Backfill } from '../src/migrations/phase-11-5/drop-legacy-tier-fields.js';

/**
 * Phase 11.5 backfill entry-point. Drops legacy single-tier fields
 * (`tier`, `tierExpiresAt`, `activeSubscriptionId`) from User docs
 * and ensures `tokenVersion` is present (defaults missing values
 * to 1 — schema default for new rows).
 *
 * Idempotent. Operator workflow:
 *   1. Roll new app/worker images.
 *   2. pnpm tsx scripts/backfill-phase-11-5.ts
 *   3. pnpm tsx scripts/bump-token-versions.ts (separate step:
 *      invalidates every existing JWT)
 */
const EnvSchema = z.object({ MONGO_URI: z.string().min(1) });

async function main(): Promise<void> {
  const env = EnvSchema.parse(process.env);
  await mongoose.connect(env.MONGO_URI);
  logger.info('[backfill:phase-11-5] mongo connected');

  try {
    const report = await runPhase115Backfill();
    logger.info(report, '[backfill:phase-11-5] all migrations complete');
  } finally {
    await mongoose.disconnect();
    logger.info('[backfill:phase-11-5] mongo disconnected');
  }
}

main().catch((err: unknown) => {
  logger.error({ err }, '[backfill:phase-11-5] FATAL');
  process.exit(1);
});
