import { Schema, model, type HydratedDocument, type Model, type Types } from 'mongoose';
import { baseSchemaOptions } from './_base.js';

/**
 * Source-of-truth idempotency key for external webhooks. Razorpay
 * retries non-2xx responses for up to 24h; eventId (unique) makes
 * retries safe. See PAYMENTS.md §5.
 */
export interface WebhookEventAttrs {
  _id: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
  source: 'RAZORPAY' | 'FCM';
  eventId: string; // X-Razorpay-Event-Id
  eventType?: string;
  /** Raw provider event body; shape varies per event. Stored for replay + debug. */
  payload?: Record<string, unknown>;
  status: 'RECEIVED' | 'PROCESSING' | 'DONE' | 'FAILED';
  attempts: number;
  lastError?: string;
  receivedAt?: Date;
  processedAt?: Date;
}

const WebhookEventSchema = new Schema(
  {
    source: { type: String, enum: ['RAZORPAY', 'FCM'], required: true },
    eventId: { type: String, required: true, unique: true }, // X-Razorpay-Event-Id
    eventType: { type: String, index: true },
    payload: Schema.Types.Mixed,
    status: {
      type: String,
      enum: ['RECEIVED', 'PROCESSING', 'DONE', 'FAILED'],
      default: 'RECEIVED',
      index: true,
    },
    attempts: { type: Number, default: 0 },
    lastError: String,
    receivedAt: Date,
    processedAt: Date,
  },
  baseSchemaOptions,
);

export type WebhookEventDoc = HydratedDocument<WebhookEventAttrs>;
export const WebhookEventModel: Model<WebhookEventAttrs> = model<WebhookEventAttrs>(
  'WebhookEvent',
  WebhookEventSchema,
  'webhook_events',
);
export { WebhookEventSchema };
