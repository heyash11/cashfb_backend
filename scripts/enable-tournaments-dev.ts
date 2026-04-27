import mongoose from 'mongoose';
import { z } from 'zod';
import { logger } from '../src/config/logger.js';
import { runEnableTournamentsDev } from '../src/migrations/phase-11-6/enable-tournaments-flag.js';

/**
 * Phase 11.6 — DEV-ONLY operator script. Flips the
 * `app_config.featureFlags.tournaments` flag to `true` so the
 * tournaments / custom-rooms user-facing surface stops returning
 * FEATURE_DISABLED for local Flutter integration work.
 *
 * **DO NOT RUN AGAINST PRODUCTION.** CLAUDE.md §0.1 binds this flag
 * to legal sign-off on PROGA 2025 implications. The script bails
 * out hard when NODE_ENV=production.
 *
 * Usage:
 *   pnpm tsx scripts/enable-tournaments-dev.ts
 */
const EnvSchema = z.object({ MONGO_URI: z.string().min(1) });

async function main(): Promise<void> {
  if (process.env['NODE_ENV'] === 'production') {
    throw new Error(
      '[enable-tournaments-dev] refusing to run with NODE_ENV=production. This is a dev-only flag flip.',
    );
  }
  const env = EnvSchema.parse(process.env);
  await mongoose.connect(env.MONGO_URI);
  logger.info('[enable-tournaments-dev] mongo connected');

  try {
    const report = await runEnableTournamentsDev();
    logger.info(report, '[enable-tournaments-dev] tournaments flag enabled');
  } finally {
    await mongoose.disconnect();
    logger.info('[enable-tournaments-dev] mongo disconnected');
  }
}

main().catch((err: unknown) => {
  logger.error({ err }, '[enable-tournaments-dev] FATAL');
  process.exit(1);
});
