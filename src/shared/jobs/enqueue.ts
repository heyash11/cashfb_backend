import { getQueue } from '../../config/queues.js';
import { JOB_NAMES, QUEUES } from '../../workers/_registry.js';

/**
 * Service → Queue enqueue helpers. Thin wrappers around
 * `getQueue(X).add(...)` that enforce serialization discipline:
 * BullMQ JSON-serializes job.data on enqueue, so `Types.ObjectId`
 * instances don't round-trip through Redis cleanly. Helpers take
 * ObjectIds as parameters, stringify at the boundary; handlers
 * receive plain strings and reconstruct via `new Types.ObjectId(...)`
 * as needed.
 *
 * BullMQ dedupes on `jobId`; duplicate adds return an existing job
 * reference rather than creating a new one (see
 * https://docs.bullmq.io/patterns/idempotent-jobs). This lets
 * callers re-enqueue safely on retries without worrying about
 * double-processing.
 */

export interface InvoiceJobPayload {
  paymentId: string;
}

export interface WebhookRetryJobPayload {
  eventId: string;
  attempt: number;
}

export async function enqueueInvoice(payload: InvoiceJobPayload): Promise<void> {
  const queue = getQueue<InvoiceJobPayload>(QUEUES.INVOICE);
  await queue.add(JOB_NAMES.INVOICE_GENERATE, payload, {
    // jobId dedup: a second enqueue for the same paymentId (e.g.
    // webhook re-delivery after worker crash) returns the existing
    // job reference. Same-day idempotency matches the domain-level
    // SubscriptionPayment.razorpayPaymentId unique index.
    jobId: `invoice-${payload.paymentId}`,
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
  });
}

export async function enqueueWebhookRetry(payload: WebhookRetryJobPayload): Promise<void> {
  const queue = getQueue<WebhookRetryJobPayload>(QUEUES.WEBHOOK_RETRY);
  await queue.add(JOB_NAMES.WEBHOOK_RETRY, payload, {
    // jobId dedup: attempt-scoped so each retry is a distinct job;
    // the 7-attempt cap is enforced by BullMQ's `attempts` config
    // with a custom backoff strategy registered on the Worker (see
    // webhook-retry.worker.ts).
    jobId: `webhook-retry-${payload.eventId}-${payload.attempt}`,
    attempts: 7,
    backoff: { type: 'razorpay-cadence', delay: 0 },
  });
}
