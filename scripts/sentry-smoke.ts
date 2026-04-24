/**
 * Phase 9 Chunk 2 Sentry smoke harness. Invoked via tsx, with
 * instrument.ts preloaded via --import so Sentry.init runs before
 * this script imports anything. The script spies on the outgoing
 * transport so we can observe what the SDK WOULD have sent WITHOUT
 * hitting the network. NOT committed to git (see .gitignore update).
 *
 * Scenarios:
 *   no-dsn — verify client has no DSN (Sentry.init was no-op)
 *   5xx    — capture an InternalError, expect 1 envelope sent
 *   4xx    — capture a ValidationError, expect 0 envelopes (filtered)
 *   mixed  — capture 500+400+401+plain, expect 2 envelopes (500 + plain)
 */
import * as Sentry from '@sentry/node';
import {
  InternalError,
  UnauthorizedError,
  ValidationError,
} from '../src/shared/errors/AppError.js';

const scenario = process.argv[2];
process.stderr.write(`[smoke] scenario: ${scenario}\n`);

async function main(): Promise<void> {
  if (scenario === 'no-dsn') {
    const client = Sentry.getClient();
    const hasDsn = !!client?.getOptions().dsn;
    process.stderr.write(`[smoke] DSN env: ${process.env['SENTRY_DSN'] ?? '(unset)'}\n`);
    process.stderr.write(`[smoke] client-has-dsn: ${hasDsn}\n`);
    if (hasDsn) {
      process.stderr.write('[smoke] FAIL: expected no-op, got live DSN\n');
      process.exit(1);
    }
    process.stderr.write('[smoke] OK: Sentry initialized as no-op\n');
    return;
  }

  const client = Sentry.getClient();
  if (!client) {
    process.stderr.write('[smoke] FAIL: no Sentry client\n');
    process.exit(1);
    return;
  }
  const transport = client.getTransport();
  if (!transport) {
    process.stderr.write('[smoke] FAIL: no transport\n');
    process.exit(1);
    return;
  }
  const sent: unknown[] = [];
  const originalSend = transport.send.bind(transport);
  void originalSend; // keep reference for readability
  transport.send = async (envelope: unknown): Promise<{ statusCode: number }> => {
    sent.push(envelope);
    return { statusCode: 200 };
  };

  const done = (ok: boolean, msg: string): void => {
    process.stderr.write(`[smoke] ${ok ? 'OK' : 'FAIL'}: ${msg} | envelopes-sent=${sent.length}\n`);
    process.exit(ok ? 0 : 1);
  };

  if (scenario === '5xx') {
    Sentry.captureException(new InternalError('TEST_FAIL', 'deliberate 500 for smoke'));
    await Sentry.flush(5000);
    done(sent.length === 1, '500 AppError kept');
  } else if (scenario === '4xx') {
    Sentry.captureException(new ValidationError('deliberate 400 for smoke'));
    await Sentry.flush(5000);
    done(sent.length === 0, '400 AppError filtered by beforeSend');
  } else if (scenario === 'mixed') {
    Sentry.captureException(new InternalError('TEST_FAIL', 'a 500'));
    Sentry.captureException(new ValidationError('a 400'));
    Sentry.captureException(new UnauthorizedError('a 401'));
    Sentry.captureException(new Error('unknown non-AppError'));
    await Sentry.flush(5000);
    done(sent.length === 2, '500 + unknown kept, 400 + 401 dropped');
  } else {
    process.stderr.write(`[smoke] unknown scenario: ${scenario ?? '(none)'}\n`);
    process.exit(2);
  }
}

void main();
