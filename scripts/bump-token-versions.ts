import mongoose from 'mongoose';
import { z } from 'zod';
import { logger } from '../src/config/logger.js';
import { runBumpTokenVersions } from '../src/migrations/phase-11-5/drop-legacy-tier-fields.js';

/**
 * Phase 11.5 — operator-run script that bumps every user's
 * `tokenVersion` by 1. Effect: every existing JWT becomes invalid
 * on next authed request (auth middleware compares
 * claim.tokenVersion vs User.tokenVersion → TOKEN_VERSION_MISMATCH
 * 401). Users are redirected to the login flow.
 *
 * Use cases:
 *   - Deploy-time global session invalidation (breaking schema
 *     change requires fresh tokens).
 *   - Security incident requiring force-logout-everyone.
 *
 * Compare with the per-user Redis denylist (Phase 8) which is
 * still in use for ad-hoc per-user invalidation (DPDP erasure
 * cancel-revoke, admin force-logout-this-user). The two
 * mechanisms coexist; this script is the bulk primitive.
 *
 * Coordinate with deploy comms — every user gets the login
 * screen on their next request after this runs.
 */
const EnvSchema = z.object({ MONGO_URI: z.string().min(1) });

async function main(): Promise<void> {
  const env = EnvSchema.parse(process.env);
  await mongoose.connect(env.MONGO_URI);
  logger.info('[bump-token-versions] mongo connected');

  try {
    const report = await runBumpTokenVersions();
    logger.info(report, '[bump-token-versions] all users token-version-bumped');
  } finally {
    await mongoose.disconnect();
    logger.info('[bump-token-versions] mongo disconnected');
  }
}

main().catch((err: unknown) => {
  logger.error({ err }, '[bump-token-versions] FATAL');
  process.exit(1);
});
