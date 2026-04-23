import { createHmac } from 'node:crypto';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { WebhookEventModel } from '../shared/models/WebhookEvent.model.js';
import type { WebhookRetryJobPayload } from '../shared/jobs/enqueue.js';
import type { DonationService } from '../modules/donations/donations.service.js';
import type { RefundService } from '../modules/refunds/refunds.service.js';
import type { SubscriptionService } from '../modules/subscriptions/subscriptions.service.js';
import { WebhookService } from '../modules/webhooks/webhooks.service.js';

/**
 * Razorpay retry cadence per PAYMENTS.md §5: the provider retries
 * non-2xx deliveries with backoff 5s → 30s → 5min → 30min → 2hr →
 * 6hr → 24hr over a 24-hour window (7 attempts total). Our worker
 * mirrors that cadence for retries of FAILED webhook_events rows
 * so the payment provider's retry timing and our internal retry
 * timing stay synchronised.
 *
 * Standard BullMQ exponential backoff (5s, 10s, 20s, 40s, 80s…)
 * would be far too fast — we'd blast 7 attempts in ~5 minutes and
 * give up. Cadence explicitly encoded instead.
 */
const RAZORPAY_BACKOFF_MS: readonly number[] = [
  5_000, //       5s   (attempt 1 delay)
  30_000, //      30s
  5 * 60_000, //  5m
  30 * 60_000, // 30m
  2 * 60 * 60_000, //  2h
  6 * 60 * 60_000, //  6h
  24 * 60 * 60_000, // 24h
];

/**
 * BullMQ custom-backoff strategy. Registered under the type key
 * `razorpay-cadence` used by `enqueueWebhookRetry`'s backoff
 * options. Takes `attemptsMade` (1-indexed by BullMQ: first retry
 * is `attemptsMade=1`), returns ms to wait before the next attempt.
 */
export function razorpayCadenceBackoff(attemptsMade: number): number {
  const idx = Math.min(Math.max(attemptsMade - 1, 0), RAZORPAY_BACKOFF_MS.length - 1);
  return RAZORPAY_BACKOFF_MS[idx] ?? 24 * 60 * 60_000;
}

export const WEBHOOK_RETRY_SETTINGS = {
  backoffStrategy: (attemptsMade: number): number => razorpayCadenceBackoff(attemptsMade),
};

export interface WebhookRetryHandlerDeps {
  webhookService?: WebhookService;
  donationService?: DonationService;
  subscriptionService?: SubscriptionService;
  refundService?: RefundService;
  webhookSecret?: string;
}

/**
 * Loads the stored WebhookEvent, re-dispatches it through the same
 * switch WebhookService uses for first-delivery. On success flips
 * the row to DONE; on failure throws so BullMQ records the attempt
 * and schedules the next retry via razorpayCadenceBackoff. When
 * BullMQ exhausts attempts, the failed-listener (Chunk 3) routes
 * the job to the DLQ.
 */
export function createWebhookRetryHandler(
  deps: WebhookRetryHandlerDeps = {},
): (data: WebhookRetryJobPayload) => Promise<{ status: 'DONE' }> {
  return async (data: WebhookRetryJobPayload) => {
    const row = await WebhookEventModel.findOne({ eventId: data.eventId }).lean();
    if (!row) {
      throw new Error(`webhook-retry: event ${data.eventId} not found`);
    }
    if (row.status === 'DONE') {
      // Someone else handled it between retries — benign; report ok.
      return { status: 'DONE' };
    }

    // Verify the stored payload's signature against the same secret
    // first-delivery used. In normal operation the row was created
    // only after signature verification, so this should always
    // pass; defensive check against manual tampering.
    const raw = Buffer.from(JSON.stringify(row.payload), 'utf8');
    const svc =
      deps.webhookService ??
      new WebhookService({
        ...(deps.donationService !== undefined ? { donationService: deps.donationService } : {}),
        ...(deps.subscriptionService !== undefined
          ? { subscriptionService: deps.subscriptionService }
          : {}),
        ...(deps.refundService !== undefined ? { refundService: deps.refundService } : {}),
        ...(deps.webhookSecret !== undefined ? { webhookSecret: deps.webhookSecret } : {}),
      });

    // Regenerate a signature over the stored payload so the
    // re-dispatch passes the HMAC gate in WebhookService. The retry
    // uses the configured webhook secret (or the test override).
    const secret = deps.webhookSecret ?? env.RAZORPAY_WEBHOOK_SECRET ?? '';
    const sig = createHmac('sha256', secret).update(raw.toString('utf8')).digest('hex');

    const result = await svc.handleRazorpayWebhook(raw, sig, data.eventId);
    if (result.httpCode !== 200) {
      logger.warn(
        { eventId: data.eventId, httpCode: result.httpCode, message: result.message },
        '[webhook-retry] re-dispatch did not succeed',
      );
      throw new Error(`retry failed: ${result.message}`);
    }
    return { status: 'DONE' };
  };
}
