import { Schema, model, type HydratedDocument, type InferSchemaType, type Model } from 'mongoose';
import { baseSchemaOptions } from './_base.js';

/**
 * Source-of-truth idempotency key for external webhooks. Razorpay
 * retries non-2xx responses for up to 24h; eventId (unique) makes
 * retries safe. See PAYMENTS.md §5.
 */
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

export type WebhookEventAttrs = InferSchemaType<typeof WebhookEventSchema>;
export type WebhookEventDoc = HydratedDocument<WebhookEventAttrs>;
export const WebhookEventModel: Model<WebhookEventAttrs> = model<WebhookEventAttrs>(
  'WebhookEvent',
  WebhookEventSchema,
  'webhook_events',
);
export { WebhookEventSchema };
