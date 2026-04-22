import mongoose from 'mongoose';

/**
 * Helpers for integration-test Mongo lifecycle. The single-node
 * replset is booted once by `globalSetup.ts`; per-spec files just
 * connect, clear, disconnect.
 */

/**
 * Scope the shared MongoMemoryReplSet to a per-worker database so
 * parallel spec files cannot clobber each other's fixtures. Vitest
 * threaded pool spawns one worker per file with a stable
 * `VITEST_WORKER_ID`, which we append to the dbname.
 *
 * The globalSetup replset URI looks like
 *   mongodb://127.0.0.1:PORT/?replicaSet=rs0
 * We splice a per-worker dbname between the host and the query
 * string so each worker gets its own isolated namespace.
 */
export function testMongoUri(): string {
  const base = process.env['TEST_MONGO_URI'];
  if (!base) {
    throw new Error(
      'TEST_MONGO_URI is not set. Run via `pnpm test` (Vitest globalSetup boots the replset).',
    );
  }
  const workerId = process.env['VITEST_WORKER_ID'] ?? '1';
  const [hostPart, query] = base.split('?');
  const host = (hostPart ?? '').replace(/\/$/, '');
  const dbName = `cashfb_worker_${workerId}`;
  return query ? `${host}/${dbName}?${query}` : `${host}/${dbName}`;
}

export async function connectTestMongo(): Promise<void> {
  if (mongoose.connection.readyState === 1) return;
  await mongoose.connect(testMongoUri());
}

export async function disconnectTestMongo(): Promise<void> {
  if (mongoose.connection.readyState === 0) return;
  await mongoose.disconnect();
}

/**
 * Wipe every collection on the active connection. Tests call this in
 * `beforeEach` for isolation. Indexes survive — they were created on
 * model load.
 */
export async function clearAllCollections(): Promise<void> {
  const db = mongoose.connection.db;
  if (!db) throw new Error('no active mongoose connection');
  const collections = await db.collections();
  await Promise.all(collections.map((c) => c.deleteMany({})));
}
