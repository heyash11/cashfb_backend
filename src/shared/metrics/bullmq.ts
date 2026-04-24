import { getQueue } from '../../config/queues.js';
import { logger } from '../../config/logger.js';
import { QUEUES } from '../../workers/_registry.js';
import { bullmqQueueDepth } from './registry.js';

/**
 * Poll interval for the api-process BullMQ depth sampler. Matches
 * typical Prometheus scrape cadences (15s / 30s / 1m) — shorter
 * than the default scrape so every scrape sees at least one fresh
 * sample. If you lower this, remember it runs on the api process
 * (shared across every request-serving Node) so it must stay well
 * under the event-loop budget.
 */
const BULLMQ_POLL_INTERVAL_MS = 15_000;

/**
 * States we export. `completed` intentionally omitted — it grows
 * unboundedly (every successful job contributes) and is already
 * captured implicitly by rate() over completions on the Worker
 * side. The four states below are the actionable ones for
 * ops dashboards + alerts.
 */
const STATES = ['waiting', 'active', 'delayed', 'failed'] as const;
type State = (typeof STATES)[number];

/**
 * Counts snapshot returned by BullMQ's getJobCounts. Field names
 * match BullMQ's internal vocabulary; we mirror them here so the
 * poller doesn't translate state names.
 */
type Counts = Record<State, number>;

const POLLED_QUEUES = [QUEUES.CRON, QUEUES.INVOICE, QUEUES.WEBHOOK_RETRY, QUEUES.DLQ] as const;

/**
 * One-shot collection pass. Visible for tests — they inject a
 * fake `getCountsFn` so no real Redis is touched. In production
 * `startBullmqMetricsPoll` calls this every interval.
 */
export async function collectBullmqDepthOnce(
  getCountsFn: (queueName: string) => Promise<Partial<Counts>> = async (name) => {
    const q = getQueue(name);
    return (await q.getJobCounts(...STATES)) as Partial<Counts>;
  },
): Promise<void> {
  for (const queue of POLLED_QUEUES) {
    try {
      const counts = await getCountsFn(queue);
      for (const state of STATES) {
        // Explicit zero over absence: Prometheus rate() over a
        // missing series is silently 0, but an ALERT on
        // `absent(bullmq_queue_depth{queue="x",state="waiting"})`
        // would misfire. Setting 0 keeps the series present.
        const v = counts[state];
        bullmqQueueDepth.set({ queue, state }, typeof v === 'number' ? v : 0);
      }
    } catch (err) {
      logger.warn({ err, queue }, '[metrics] bullmq depth poll failed for queue');
    }
  }
}

/**
 * Start the periodic BullMQ depth poll. Called once from
 * `src/server.ts` after mongoose + app are ready. Returns the
 * NodeJS.Timeout so tests / future shutdown code can clear it.
 *
 * `.unref()` is CRITICAL: without it, the still-running timer
 * would keep the Node event loop alive after SIGTERM + server
 * close, stalling graceful shutdown until the next tick fires.
 */
export function startBullmqMetricsPoll(): NodeJS.Timeout {
  // Kick off an immediate pass so the first scrape after boot
  // sees real numbers instead of zeros.
  void collectBullmqDepthOnce();
  const handle = setInterval(() => {
    void collectBullmqDepthOnce();
  }, BULLMQ_POLL_INTERVAL_MS);
  handle.unref();
  return handle;
}
