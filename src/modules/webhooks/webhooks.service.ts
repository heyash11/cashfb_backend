import Razorpay from 'razorpay';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import type { DonationService } from '../donations/donations.service.js';
import {
  WebhookEventModel,
  type WebhookEventAttrs,
} from '../../shared/models/WebhookEvent.model.js';

/**
 * Webhook idempotency uses findOneAndUpdate with $setOnInsert as the
 * atomic gate. A naive findOne-then-upsert has a race window: two
 * concurrent deliveries both read null, both attempt dispatch.
 * $setOnInsert + unique eventId gives us single-winner semantics.
 * See CONVENTIONS.md §Advisory pre-checks vs atomic predicates.
 */

export interface WebhookServiceDeps {
  donationService?: DonationService;
  webhookSecret?: string;
  /** Inject a dispatcher spy in tests. Optional — defaults to the
   *  built-in event-type switch. */
  dispatcher?: (eventType: string, payload: unknown) => Promise<void>;
  clock?: () => Date;
}

export interface HandleWebhookResult {
  httpCode: 200 | 400 | 500;
  message:
    | 'ok'
    | 'duplicate'
    | 'concurrent'
    | 'missing headers'
    | 'invalid signature'
    | 'invalid payload'
    | 'retry';
}

interface RazorpayEventEnvelope {
  event: string;
  payload: unknown;
}

export class WebhookService {
  private readonly donationService: DonationService | undefined;
  private readonly webhookSecret: string;
  private readonly dispatcher: (eventType: string, payload: unknown) => Promise<void>;
  private readonly clock: () => Date;

  constructor(deps: WebhookServiceDeps) {
    this.donationService = deps.donationService;
    this.webhookSecret =
      deps.webhookSecret ?? env.RAZORPAY_WEBHOOK_SECRET ?? 'dev-webhook-secret-placeholder';
    this.dispatcher = deps.dispatcher ?? this.defaultDispatcher.bind(this);
    this.clock = deps.clock ?? (() => new Date());
  }

  async handleRazorpayWebhook(
    raw: Buffer,
    signature: string | undefined,
    eventId: string | undefined,
  ): Promise<HandleWebhookResult> {
    if (!signature || !eventId) {
      return { httpCode: 400, message: 'missing headers' };
    }

    const rawStr = raw.toString('utf8');

    let sigOk = false;
    try {
      sigOk = Razorpay.validateWebhookSignature(rawStr, signature, this.webhookSecret);
    } catch {
      sigOk = false;
    }
    if (!sigOk) {
      return { httpCode: 400, message: 'invalid signature' };
    }

    let event: RazorpayEventEnvelope;
    try {
      event = JSON.parse(rawStr) as RazorpayEventEnvelope;
      if (typeof event.event !== 'string') throw new Error('missing event');
    } catch {
      return { httpCode: 400, message: 'invalid payload' };
    }

    const now = this.clock();

    // Atomic insert-or-inspect. $setOnInsert ONLY — we never overwrite
    // an existing row's status here. `rawResult: true` exposes
    // `lastErrorObject.updatedExisting` so we can tell insert-winner
    // from already-present.
    const upsert = await WebhookEventModel.findOneAndUpdate(
      { eventId },
      {
        $setOnInsert: {
          source: 'RAZORPAY',
          eventId,
          eventType: event.event,
          payload: event,
          receivedAt: now,
          status: 'PROCESSING',
          attempts: 0,
        },
      },
      { upsert: true, new: false, rawResult: true, includeResultMetadata: true },
    );

    const updatedExisting = upsert?.lastErrorObject?.updatedExisting === true;

    if (!updatedExisting) {
      // We are the insert-winner. Own dispatch.
      return this.dispatchAndFinalise(eventId, event, now);
    }

    // Row existed before our upsert. Inspect pre-state.
    const prev = upsert.value as WebhookEventAttrs | null;
    if (!prev) {
      // Shouldn't happen when updatedExisting is true; defensive.
      return { httpCode: 500, message: 'retry' };
    }

    if (prev.status === 'DONE') return { httpCode: 200, message: 'duplicate' };
    if (prev.status === 'PROCESSING') return { httpCode: 200, message: 'concurrent' };

    // FAILED or RECEIVED — atomic reclaim predicated on status.
    const reclaimed = await WebhookEventModel.findOneAndUpdate(
      { eventId, status: { $in: ['FAILED', 'RECEIVED'] } },
      { $set: { status: 'PROCESSING' }, $inc: { attempts: 1 } },
      { new: true },
    );
    if (!reclaimed) {
      // Another worker reclaimed between our read and write.
      return { httpCode: 200, message: 'concurrent' };
    }
    return this.dispatchAndFinalise(eventId, event, now);
  }

  private async dispatchAndFinalise(
    eventId: string,
    event: RazorpayEventEnvelope,
    now: Date,
  ): Promise<HandleWebhookResult> {
    try {
      await this.dispatcher(event.event, event.payload);
      await WebhookEventModel.updateOne(
        { eventId },
        { $set: { status: 'DONE', processedAt: now } },
      );
      return { httpCode: 200, message: 'ok' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await WebhookEventModel.updateOne(
        { eventId },
        { $inc: { attempts: 1 }, $set: { status: 'FAILED', lastError: message } },
      );
      logger.warn({ eventId, eventType: event.event, err: message }, 'webhook dispatch failed');
      return { httpCode: 500, message: 'retry' };
    }
  }

  /**
   * Default event-type switch. Phase 5 Chunk 1 only wires donation
   * captured; subscription + refund handlers throw NOT_IMPLEMENTED so
   * a real Razorpay event in dev fails loudly and Chunk 2 picks them
   * up.
   */
  private async defaultDispatcher(eventType: string, payload: unknown): Promise<void> {
    switch (eventType) {
      case 'payment.captured':
      case 'order.paid':
        if (!this.donationService) {
          throw new Error('NOT_IMPLEMENTED: donationService not wired');
        }
        await this.donationService.onCaptured(
          payload as Parameters<DonationService['onCaptured']>[0],
        );
        return;
      case 'subscription.authenticated':
      case 'subscription.activated':
      case 'subscription.charged':
      case 'subscription.completed':
      case 'subscription.cancelled':
      case 'subscription.halted':
      case 'subscription.paused':
      case 'subscription.resumed':
      case 'subscription.pending':
        throw new Error(`NOT_IMPLEMENTED: ${eventType} — wired in Phase 5 Chunk 2`);
      case 'refund.processed':
        throw new Error('NOT_IMPLEMENTED: refund.processed — wired in Phase 5 Chunk 4');
      default:
        logger.info({ eventType }, 'webhook: unknown event type, ignored');
        return;
    }
  }
}
