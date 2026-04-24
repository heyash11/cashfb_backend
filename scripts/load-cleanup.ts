/**
 * Phase 9 Chunk 5 — load-test state cleanup. Drops everything the
 * k6 scripts produced so the next run starts from a clean slate.
 *
 * Refuses to run unless MONGO_URI targets `cashfb_integration` —
 * same safety pattern as scripts/dpdp-smoke.ts. Prevents accidental
 * nuking of the dev DB.
 *
 * Usage:
 *   MONGO_URI='mongodb://localhost:27018/cashfb_integration?directConnection=true' \
 *   REDIS_URL='redis://localhost:6380/15' \
 *   npx tsx scripts/load-cleanup.ts
 *
 * Or via the wrapper script: `pnpm load:cleanup`.
 */
import mongoose from 'mongoose';
import { redis } from '../src/config/redis.js';

async function main(): Promise<void> {
  const uri = process.env['MONGO_URI'];
  if (!uri?.includes('cashfb_integration')) {
    throw new Error('load:cleanup refuses to run: MONGO_URI must target cashfb_integration DB');
  }
  await mongoose.connect(uri);

  const db = mongoose.connection.db;
  if (!db) throw new Error('no mongoose connection');

  await db.dropDatabase();
  await redis.flushdb();

  process.stderr.write('[load:cleanup] cashfb_integration dropped + Redis db flushed\n');

  await mongoose.disconnect();
  await redis.quit();
}

void main().catch((err) => {
  process.stderr.write(`[load:cleanup] failed: ${String(err)}\n`);
  process.exit(1);
});
