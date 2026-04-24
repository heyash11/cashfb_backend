// TODO: Bump to Vitest 4.x once @vitest/coverage-v8@4 stabilises peer-dep range.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    pool: 'threads',
    environment: 'node',
    globals: false,
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
    /**
     * Phase 9 Chunk 1 flow specs live under test/integration/flows/**
     * and require the docker compose stack (Mongo replset on :27018,
     * Redis on :6380). They run via `pnpm test:integration` against
     * vitest.config.integration.ts and must be excluded here so
     * `pnpm test` stays green without docker.
     */
    exclude: ['**/node_modules/**', '**/dist/**', 'test/integration/flows/**'],
    /**
     * 10 seconds, doubled from Vitest's 5-second default. Two
     * integration specs (users.coins 150-row pagination and the
     * audit-export 1000-row heap-delta check) intermittently exceed
     * 5 s under full-suite load on shared hardware. Real hangs still
     * fail, just 5 s later.
     */
    testTimeout: 10_000,
    hookTimeout: 10_000,
    /**
     * One-shot MongoMemoryReplSet boot per test run, shared across
     * all integration specs via `process.env.TEST_MONGO_URI`.
     */
    globalSetup: ['./test/testing/globalSetup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/modules/**/*.service.ts', 'src/modules/**/*.repository.ts'],
      thresholds: {
        lines: 80,
        functions: 70,
        statements: 80,
        branches: 70,
      },
    },
  },
});
