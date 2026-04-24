import * as Sentry from '@sentry/node';
import { logger } from '../config/logger.js';

/**
 * Process-level error handlers. Installed once by both `server.ts`
 * and `worker.ts` after their bootstrap completes.
 *
 * Semantics:
 *   - `unhandledRejection`: log + Sentry.captureException, do NOT
 *     exit. Node's default would warn and keep running; exiting
 *     aggressively here would surprise engineers debugging flaky
 *     background work. We rely on Sentry alerting to flag these.
 *   - `uncaughtException`: log + Sentry.captureException + flush +
 *     exit(1). Node considers the process state indeterminate after
 *     this signal — safer to crash and let ECS restart. Flush gives
 *     the Sentry SDK up to 30 s to deliver the event before the
 *     process dies; without it, the exit would race and the crash
 *     report would be lost.
 *
 * Absent DSN posture: `Sentry.captureException` + `Sentry.flush`
 * are cheap no-ops when `Sentry.init` ran without a DSN (see
 * instrument.ts). No extra conditional needed.
 */

const FLUSH_TIMEOUT_MS = 30_000;

export interface InstallOptions {
  /** Injectable for tests that need to verify exit was invoked. */
  exit?: (code: number) => void;
}

let installed = false;

export function installProcessHandlers(opts: InstallOptions = {}): void {
  if (installed) return;
  installed = true;
  const doExit = opts.exit ?? ((code: number) => process.exit(code));

  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, '[process] unhandled promise rejection');
    Sentry.captureException(reason);
  });

  process.on('uncaughtException', (err) => {
    logger.error({ err }, '[process] uncaught exception — flushing Sentry and exiting');
    Sentry.captureException(err);
    // flush() resolves once in-flight events are delivered OR the
    // timeout hits (whichever comes first). We exit in the same tick
    // either way — correctness-wise, a lost event is strictly better
    // than a hanging process after uncaughtException.
    Sentry.flush(FLUSH_TIMEOUT_MS).finally(() => {
      doExit(1);
    });
  });
}

/** Visible for tests only. Resets the single-install guard. */
export function __resetProcessHandlersForTest(): void {
  installed = false;
}
