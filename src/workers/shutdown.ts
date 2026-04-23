import type { Worker } from 'bullmq';
import { logger } from '../config/logger.js';
import { closeAllQueues } from '../config/queues.js';

const registeredWorkers: Worker[] = [];

/**
 * Track a Worker so graceful-shutdown knows to close it. Called
 * from each worker-boot site in `src/worker.ts` after `makeWorker`
 * returns.
 */
export function registerWorker(w: Worker): void {
  registeredWorkers.push(w);
}

/**
 * Visible for tests that want to reset state between worker boots
 * within the same process.
 */
export function __clearWorkerRegistry(): void {
  registeredWorkers.length = 0;
}

/**
 * Gracefully close every registered Worker, waiting for in-flight
 * jobs to complete, then close every cached Queue.
 *
 * `Worker.close()` returns once no job is being processed; the
 * worker stops picking up new jobs the moment close() starts. ECS
 * gives tasks 10 s of SIGTERM grace — that's enough for our
 * ~hundreds-of-ms handlers.
 */
export async function shutdownWorkers(signal: string): Promise<void> {
  logger.info(
    { signal, workerCount: registeredWorkers.length },
    '[worker] shutdown: draining in-flight jobs',
  );
  await Promise.all(registeredWorkers.map((w) => w.close()));
  await closeAllQueues();
  logger.info('[worker] shutdown: drained + queues closed');
}

/**
 * Install SIGTERM + SIGINT handlers once at boot. Duplicate calls
 * are no-ops (guarded internally).
 */
let installed = false;
export function installShutdownHandlers(): void {
  if (installed) return;
  installed = true;
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sig, () => {
      shutdownWorkers(sig)
        .then(() => process.exit(0))
        .catch((err: unknown) => {
          logger.error({ err }, '[worker] shutdown failed');
          process.exit(1);
        });
    });
  }
}
