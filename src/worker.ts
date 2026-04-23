import mongoose from 'mongoose';
import type { Job } from 'bullmq';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { getQueue, makeWorker } from './config/queues.js';
import { CRON_SCHEDULES, JOB_NAMES, QUEUES, type JobName } from './workers/_registry.js';
import { createPrizePoolHandler, type PrizePoolJobData } from './workers/prize-pool.worker.js';
import {
  createReconcileCodesHandler,
  type ReconcileCodesJobData,
} from './workers/reconcile-codes.worker.js';
import { routeFailedToDlq } from './workers/dlq.js';
import { createInvoiceHandler } from './workers/invoice.worker.js';
import {
  WEBHOOK_RETRY_SETTINGS,
  createWebhookRetryHandler,
} from './workers/webhook-retry.worker.js';
import { installShutdownHandlers, registerWorker } from './workers/shutdown.js';
import { createTierSweepHandler, type TierSweepJobData } from './workers/tier-sweep.worker.js';
import { createTopDonorHandler, type TopDonorJobData } from './workers/top-donor.worker.js';
import type { InvoiceJobPayload, WebhookRetryJobPayload } from './shared/jobs/enqueue.js';

/**
 * Top-level worker process. One Node process boots all cron
 * workers (single `cron` queue, job-name routing) plus two
 * event-driven Workers: `invoice` and `webhook-retry`.
 *
 * Monolithic worker per Phase 7 product decision. Split trigger is
 * production signal that one queue's handler profile diverges from
 * others — CPU-heavy invoice generation is the obvious candidate.
 *
 * Graceful shutdown: SIGTERM / SIGINT → worker.close() per worker
 * (waits for in-flight jobs) → closeAllQueues() → process.exit(0).
 * ECS gives 10 s grace which covers our hundreds-of-ms handlers.
 */

// ISO timestamp derivation for cron fires — BullMQ populates
// `job.timestamp` with the fire time. Tests bypass this entirely by
// calling handlers directly with POJO data.
function scheduledForFromJob(job: Job<{ scheduledFor?: string }>): string {
  return job.data.scheduledFor ?? new Date(job.timestamp).toISOString();
}

async function main(): Promise<void> {
  logger.info({ env: env.NODE_ENV }, '[worker] boot');

  await mongoose.connect(env.MONGO_URI);
  logger.info('[worker] mongo connected');

  // Lazy Queue construction + register repeatable schedulers. BullMQ
  // dedupes on jobId; duplicate adds return existing job reference
  // (see https://docs.bullmq.io/patterns/idempotent-jobs). Same
  // scheduler ID on boot is safe — upsertJobScheduler replaces the
  // prior schedule with identical options.
  const cronQueue = getQueue(QUEUES.CRON);
  for (const jobName of [
    JOB_NAMES.PRIZE_POOL_DAILY,
    JOB_NAMES.RECONCILE_CODES_HOURLY,
    JOB_NAMES.TOP_DONOR_REFRESH,
    JOB_NAMES.TIER_EXPIRY_SWEEP,
  ] as const) {
    const spec = CRON_SCHEDULES[jobName];
    if (!spec) continue;
    await cronQueue.upsertJobScheduler(
      jobName,
      { pattern: spec.pattern, tz: spec.tz },
      { name: jobName, data: {} },
    );
    logger.info({ jobName, pattern: spec.pattern, tz: spec.tz }, '[worker] scheduler registered');
  }

  // Instantiate handlers with their default service deps.
  const prizePool = createPrizePoolHandler();
  const reconcile = createReconcileCodesHandler();
  const topDonor = createTopDonorHandler();
  const tierSweep = createTierSweepHandler({
    enqueueContinuation: async (data) => {
      await cronQueue.add(JOB_NAMES.TIER_EXPIRY_SWEEP, data, {
        // Date.now() intentional: correctness is at the Mongo
        // predicate layer (sweepExpiredTiers's convergent
        // {tier: $ne: 'PUBLIC'} filter), not at the BullMQ jobId
        // layer. Duplicate continuations (e.g. from handler
        // crash-retry after enqueue succeeded) are harmless — they
        // all see the same predicate and flip only still-expired
        // users. A stable jobId like
        // `tier-sweep-continue-${scheduledFor}` would block
        // duplicate continuations but adds complexity without
        // correctness gain. See Chunk 3's CONVENTIONS.md addition
        // on loose vs stable jobId strategies.
        jobId: `tier-sweep-continue-${Date.now()}`,
      });
    },
  });

  // Single Worker over the `cron` queue, routing on job.name.
  const cronWorker = makeWorker<unknown, unknown>(QUEUES.CRON, async (job) => {
    const name = job.name as JobName;
    const scheduledFor = scheduledForFromJob(job as Job<{ scheduledFor?: string }>);
    switch (name) {
      case JOB_NAMES.PRIZE_POOL_DAILY:
        return prizePool({ ...(job.data as PrizePoolJobData), scheduledFor });
      case JOB_NAMES.RECONCILE_CODES_HOURLY:
        return reconcile({ ...(job.data as ReconcileCodesJobData), scheduledFor });
      case JOB_NAMES.TOP_DONOR_REFRESH:
        return topDonor({ ...(job.data as TopDonorJobData), scheduledFor });
      case JOB_NAMES.TIER_EXPIRY_SWEEP:
        return tierSweep({ ...(job.data as TierSweepJobData), scheduledFor });
      default:
        logger.warn({ name }, '[worker] unknown cron job, ignoring');
        return undefined;
    }
  });
  registerWorker(cronWorker);
  routeFailedToDlq(cronWorker);

  // Event-driven workers (Chunk 2).
  const invoiceHandler = createInvoiceHandler();
  const invoiceWorker = makeWorker<InvoiceJobPayload, unknown>(QUEUES.INVOICE, async (job) =>
    invoiceHandler(job.data),
  );
  registerWorker(invoiceWorker);
  routeFailedToDlq(invoiceWorker);

  const webhookRetryHandler = createWebhookRetryHandler();
  const webhookRetryWorker = makeWorker<WebhookRetryJobPayload, unknown>(
    QUEUES.WEBHOOK_RETRY,
    async (job) => webhookRetryHandler(job.data),
    {
      settings: {
        backoffStrategy: WEBHOOK_RETRY_SETTINGS.backoffStrategy,
      },
    },
  );
  registerWorker(webhookRetryWorker);
  routeFailedToDlq(webhookRetryWorker);

  installShutdownHandlers();
  logger.info('[worker] ready');
}

main().catch((err: unknown) => {
  logger.error({ err }, '[worker] fatal boot error');
  process.exit(1);
});
