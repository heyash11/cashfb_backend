import type { HydratedDocument, Model, UpdateWriteOpResult } from 'mongoose';
import { WebhookEventModel, type WebhookEventAttrs } from '../models/WebhookEvent.model.js';
import { BaseRepository, type WriteOpts } from './_base.repository.js';

export class WebhookEventRepository extends BaseRepository<WebhookEventAttrs> {
  constructor(model: Model<WebhookEventAttrs> = WebhookEventModel) {
    super(model);
  }

  findByEventId(eventId: string): Promise<WebhookEventAttrs | null> {
    return this.findOne({ eventId });
  }

  /**
   * Razorpay webhook idempotency (PAYMENTS.md §5). Upsert on eventId,
   * set status to PROCESSING. Callers mark DONE/FAILED after handling.
   */
  upsertForProcessing(
    eventId: string,
    source: 'RAZORPAY' | 'FCM',
    eventType: string,
    payload: unknown,
    opts: WriteOpts = {},
  ): Promise<HydratedDocument<WebhookEventAttrs> | null> {
    return this.model.findOneAndUpdate(
      { eventId },
      {
        $setOnInsert: { source, eventId, eventType, receivedAt: new Date() },
        $set: { payload, status: 'PROCESSING' },
      },
      { ...opts, upsert: true, new: true },
    );
  }

  markDone(eventId: string, opts: WriteOpts = {}): Promise<UpdateWriteOpResult> {
    return this.updateOne({ eventId }, { $set: { status: 'DONE', processedAt: new Date() } }, opts);
  }

  markFailed(eventId: string, error: string, opts: WriteOpts = {}): Promise<UpdateWriteOpResult> {
    return this.updateOne(
      { eventId },
      {
        $inc: { attempts: 1 },
        $set: { status: 'FAILED', lastError: error },
      },
      opts,
    );
  }
}
