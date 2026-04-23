/**
 * Queue + job name + cron schedule registry. Symbolic names live
 * here so worker files, the top-level `src/worker.ts` entry, and
 * `src/shared/jobs/enqueue.ts` helpers never drift from the runtime
 * queue wiring.
 *
 * Phase 7 ships a single `cron` queue for all four scheduled
 * primitives (job-name routing inside one Worker) plus two
 * event-driven queues (`invoice`, `webhook-retry`). The `dlq`
 * queue has no worker — it's an inspection surface populated by
 * the failed-listener plumbing (Chunk 3).
 */

export const QUEUES = {
  CRON: 'cron',
  INVOICE: 'invoice',
  WEBHOOK_RETRY: 'webhook-retry',
  DLQ: 'dlq',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export const JOB_NAMES = {
  PRIZE_POOL_DAILY: 'prize-pool-daily',
  RECONCILE_CODES_HOURLY: 'reconcile-codes-hourly',
  TOP_DONOR_REFRESH: 'top-donor-refresh',
  TIER_EXPIRY_SWEEP: 'tier-expiry-sweep',
  INVOICE_GENERATE: 'invoice-generate',
  WEBHOOK_RETRY: 'webhook-retry',
} as const;

export type JobName = (typeof JOB_NAMES)[keyof typeof JOB_NAMES];

export interface CronSpec {
  pattern: string;
  tz: string;
}

/**
 * Cron schedules. IST throughout per CONVENTIONS.md §Dates-and-
 * timezones. BullMQ's `upsertJobScheduler` is idempotent — calling
 * it at worker boot with the same scheduler ID replaces any existing
 * schedule with these options.
 */
export const CRON_SCHEDULES: Record<string, CronSpec> = {
  [JOB_NAMES.PRIZE_POOL_DAILY]: { pattern: '5 0 * * *', tz: 'Asia/Kolkata' },
  [JOB_NAMES.RECONCILE_CODES_HOURLY]: { pattern: '0 * * * *', tz: 'Asia/Kolkata' },
  [JOB_NAMES.TOP_DONOR_REFRESH]: { pattern: '*/5 * * * *', tz: 'Asia/Kolkata' },
  [JOB_NAMES.TIER_EXPIRY_SWEEP]: { pattern: '0 2 * * *', tz: 'Asia/Kolkata' },
};
