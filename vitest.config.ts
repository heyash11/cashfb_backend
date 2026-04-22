// TODO: Bump to Vitest 4.x once @vitest/coverage-v8@4 stabilises peer-dep range.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    pool: 'threads',
    environment: 'node',
    globals: false,
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
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
