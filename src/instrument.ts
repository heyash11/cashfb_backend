import * as Sentry from '@sentry/node';
import { env } from './config/env.js';
import { AppError } from './shared/errors/AppError.js';

/**
 * Sentry bootstrap. Loaded via `node --import ./dist/instrument.js`
 * (prod) or `tsx --import ./src/instrument.ts` (dev) so the SDK's
 * auto-instrumentation can wrap outgoing HTTP, pg, mongodb, etc.
 * BEFORE any app code imports those modules.
 *
 * Absent DSN → `Sentry.init` is a no-op. We still call it so every
 * `Sentry.captureException` in the app code path becomes a cheap
 * local no-op rather than needing a conditional at every call site.
 * Matches the MVP posture: dev runs without a DSN, CI integration
 * runs without a DSN, only staging / prod inject one via env.
 *
 * `beforeSend` drops every AppError subclass with `httpStatus < 500`.
 * Rationale: 4xx responses are client faults (bad OTP, validation
 * errors, rate limits, etc.) — not application bugs. Surfacing them
 * as Sentry issues would drown real regressions in noise. Only 5xx
 * AppError instances (genuine server faults like `InternalError`)
 * and non-AppError throws (unexpected crashes) reach the transport.
 */
Sentry.init({
  ...(env.SENTRY_DSN !== undefined ? { dsn: env.SENTRY_DSN } : {}),
  environment: env.SENTRY_ENVIRONMENT ?? env.NODE_ENV,
  ...(env.SENTRY_RELEASE !== undefined ? { release: env.SENTRY_RELEASE } : {}),
  tracesSampleRate: env.NODE_ENV === 'production' ? 0.1 : 0,
  beforeSend(event, hint) {
    const err = hint?.originalException;
    if (err instanceof AppError && err.httpStatus < 500) {
      return null;
    }
    return event;
  },
});
