import type { Job, Worker } from 'bullmq';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { getQueue } from '../config/queues.js';

export interface DlqJobPayload {
  originalQueue: string;
  originalJobId: string;
  originalJobName: string;
  originalData: unknown;
  failedReason: string;
  stackTrace?: string;
  attemptsMade: number;
  failedAt: string;
}

/**
 * Attach a `failed` listener to a Worker that copies any job which
 * has exhausted its retry budget into the shared DLQ queue. The DLQ
 * queue has no worker — it's a durable inspection surface for
 * Bull-board + a future Phase 8 "requeue from DLQ" admin action.
 *
 * Retention: indefinite in Phase 7 (jobs persisted via
 * removeOnComplete: false, removeOnFail: false on the DLQ Queue).
 * TODO(phase-8): Phase 8 adds (a) a "requeue from DLQ" admin
 * endpoint, (b) a TTL / retention policy (likely 90 days), and
 * (c) metric alerts when DLQ depth crosses a threshold. Indefinite
 * retention is acceptable for MVP but will eventually grow
 * unbounded under real load.
 *
 * Worker-level retry cap comes from `job.opts.attempts`; the
 * failed-listener fires on every attempt but only routes to DLQ
 * when `job.attemptsMade >= job.opts.attempts`.
 */
export function routeFailedToDlq(worker: Worker): void {
  worker.on('failed', (job: Job | undefined, err: Error) => {
    if (!job) return;
    const maxAttempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < maxAttempts) {
      // Not terminal yet — BullMQ will retry per the configured backoff.
      return;
    }

    const dlq = getQueue<DlqJobPayload>(env.BULL_DLQ_NAME);
    const payload: DlqJobPayload = {
      originalQueue: worker.name,
      originalJobId: job.id ?? '(no-id)',
      originalJobName: job.name,
      originalData: job.data,
      failedReason: err.message,
      ...(err.stack !== undefined ? { stackTrace: err.stack } : {}),
      attemptsMade: job.attemptsMade,
      failedAt: new Date().toISOString(),
    };

    dlq
      .add('dlq-entry', payload, {
        removeOnComplete: false,
        removeOnFail: false,
      })
      .catch((addErr: unknown) => {
        // If the DLQ enqueue itself fails, we've lost our safety net
        // for this job. Log loudly so operators notice; the original
        // failure is already logged by BullMQ's default error paths.
        logger.error(
          { addErr, originalJobId: job.id, originalQueue: worker.name },
          '[dlq] failed to route exhausted job to DLQ — job context lost',
        );
      });
  });
}
