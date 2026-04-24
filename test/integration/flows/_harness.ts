import mongoose from 'mongoose';
import { redis } from '../../../src/config/redis.js';
import { MODELS } from '../../../src/shared/models/index.js';

/**
 * Shared integration-harness helpers. The integration suite hits
 * REAL docker-composed Mongo (cashfb_integration DB) + Redis
 * (db index 15) via MONGO_URI + REDIS_URL overrides in the
 * test:integration script. Zero cross-contamination with dev data
 * (which lives in `cashfb` DB + Redis db 0).
 *
 * Each spec file calls connectHarness() in beforeAll, resets
 * state in beforeEach, and disconnectHarness() in afterAll. The
 * collection sync + Redis FLUSHDB happens on the integration DB
 * only — never touches the dev DB.
 */

type AnyModel = { syncIndexes(): Promise<string[]> };

let connected = false;

export async function connectHarness(): Promise<void> {
  if (connected) return;
  if (!process.env['MONGO_URI']?.includes('cashfb_integration')) {
    throw new Error(
      'Integration harness refuses to run: MONGO_URI must target the cashfb_integration DB. ' +
        'Run via `pnpm test:integration` (not `pnpm test`).',
    );
  }
  await mongoose.connect(process.env['MONGO_URI']);
  await Promise.all(Object.values(MODELS).map((m) => (m as unknown as AnyModel).syncIndexes()));
  connected = true;
}

export async function disconnectHarness(): Promise<void> {
  if (!connected) return;
  // Drop the DB on teardown so the next run starts clean. This is
  // safe because cashfb_integration is not shared with anything
  // except this suite. Redis db 15 is flushed on the same turn so
  // the last spec's force-logout cutoffs / admin sessions don't
  // linger between runs.
  await mongoose.connection.db?.dropDatabase();
  await redis.flushdb();
  await mongoose.disconnect();
  connected = false;
}

export async function resetMongoState(): Promise<void> {
  const db = mongoose.connection.db;
  if (!db) throw new Error('resetMongoState called before connect');
  const collections = await db.collections();
  await Promise.all(collections.map((c) => c.deleteMany({})));
}

/**
 * Wipe Redis DB 15 between specs. Safe — db 15 is the integration
 * suite's private namespace (dev server + worker use db 0).
 */
export async function resetRedisState(): Promise<void> {
  await redis.flushdb();
}

export async function resetFullState(): Promise<void> {
  await Promise.all([resetMongoState(), resetRedisState()]);
}
