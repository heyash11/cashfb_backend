import { MongoMemoryReplSet } from 'mongodb-memory-server';

/**
 * Vitest global setup — runs ONCE at the start of the full test run,
 * across all spec files. Spins up a single-node MongoMemoryReplSet
 * (needed so `mongoose.startSession` + `withTransaction` work in
 * `auth.service.spec.ts`) and exposes its URI to every worker via
 * `process.env.TEST_MONGO_URI`.
 *
 * Per-spec files still do their own `mongoose.connect` in beforeAll
 * because each worker runs in its own process.
 */
let replSet: MongoMemoryReplSet | undefined;

export async function setup(): Promise<void> {
  replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });
  process.env['TEST_MONGO_URI'] = replSet.getUri();
}

export async function teardown(): Promise<void> {
  if (replSet) {
    await replSet.stop();
    replSet = undefined;
  }
}
