import { defineConfig } from 'vitest/config';

/**
 * Integration test config. Uses the SAME env vars the dev server
 * reads (`MONGO_URI`, `REDIS_URL`) — the `test:integration` npm
 * script pins those to the docker containers plus a dedicated
 * `cashfb_integration` DB + Redis db index 15 so nothing collides
 * with dev data or BullMQ worker state.
 *
 * Separate include glob (test/integration/**) keeps these out of
 * `pnpm test` — integration specs should NOT run on every unit
 * test cycle; they're gated behind `pnpm test:integration`.
 *
 * `pool: 'forks'` + `singleFork: true` serialises specs against
 * the shared real infrastructure. Parallel against the same
 * Mongo DB would collide on collection state.
 */
export default defineConfig({
  test: {
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    // Share the module cache across spec files. Mongoose registers
    // models as a global singleton; isolated modules would trigger
    // OverwriteModelError on the second spec file that touches the
    // same model. Safe because singleFork+concurrent:false already
    // serialises execution.
    isolate: false,
    environment: 'node',
    globals: false,
    // Flow specs live under test/integration/flows/**. The parent
    // test/integration/ dir already has pre-existing specs that run
    // under `pnpm test` via MongoMemoryReplSet — those stay as-is.
    include: ['test/integration/flows/**/*.spec.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    sequence: {
      concurrent: false,
    },
  },
});
