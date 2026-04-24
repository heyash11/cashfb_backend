import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetProcessHandlersForTest, installProcessHandlers } from './process-handlers.js';

/**
 * Unit coverage for Phase 9 Chunk 2 process-level handlers. We mock
 * the @sentry/node module surface (ESM namespace exports cannot be
 * replaced via vi.spyOn) and swap `process.on` with a capturing stub
 * so the listeners under test can be invoked deterministically, then
 * assert the Sentry + exit contract.
 */
vi.mock('@sentry/node', () => ({
  captureException: vi.fn(() => 'test-event-id'),
  flush: vi.fn(async () => true),
}));

import * as Sentry from '@sentry/node';

describe('process-handlers', () => {
  let listeners: Map<string, (...args: unknown[]) => void>;
  let originalProcessOn: typeof process.on;

  beforeEach(() => {
    __resetProcessHandlersForTest();
    listeners = new Map();
    originalProcessOn = process.on.bind(process);
    process.on = vi.fn((event: string, fn: (...args: unknown[]) => void) => {
      listeners.set(event, fn);
      return process;
    }) as unknown as typeof process.on;
    vi.mocked(Sentry.captureException).mockClear();
    vi.mocked(Sentry.flush).mockClear();
  });

  afterEach(() => {
    process.on = originalProcessOn;
  });

  it('unhandledRejection: captureException called, process does NOT exit', () => {
    const exit = vi.fn();
    installProcessHandlers({ exit });

    const handler = listeners.get('unhandledRejection');
    expect(handler).toBeDefined();
    handler!(new Error('rejected promise'));

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
  });

  it('uncaughtException: captureException + flush + exit(1) in order', async () => {
    const exit = vi.fn();
    installProcessHandlers({ exit });

    const handler = listeners.get('uncaughtException');
    expect(handler).toBeDefined();
    handler!(new Error('uncaught'));

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.flush).toHaveBeenCalledWith(30_000);
    // flush is async — exit happens on the same microtask tick after
    // the promise resolves. Await a microtask drain so the .finally
    // callback has fired.
    await Promise.resolve();
    await Promise.resolve();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('no-op path when SENTRY_DSN absent: both handlers still register + fire without throwing', () => {
    // instrument.ts calls Sentry.init with dsn:undefined which is a
    // no-op. captureException + flush become cheap no-ops in the real
    // SDK. Our module mock above simulates that cheap no-op — the
    // point of this spec is that the handler itself does not throw or
    // branch on DSN presence (all DSN branching lives inside the
    // Sentry SDK).
    const exit = vi.fn();
    installProcessHandlers({ exit });

    const rejection = listeners.get('unhandledRejection');
    const uncaught = listeners.get('uncaughtException');
    expect(() => rejection!('string rejection reason')).not.toThrow();
    expect(() => uncaught!(new Error('boom'))).not.toThrow();
    // Both handlers called captureException — the SDK-level no-op is
    // what makes this path cheap, not any conditional in our code.
    expect(Sentry.captureException).toHaveBeenCalledTimes(2);
  });
});
