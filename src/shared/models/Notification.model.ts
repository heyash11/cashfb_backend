import { Schema, model, Types, type HydratedDocument, type Model } from 'mongoose';
import { baseSchemaOptions } from './_base.js';

export interface NotificationAttrs {
  _id: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
  /** null/absent for broadcasts. */
  userId?: Types.ObjectId;
  type:
    | 'POST_PUBLISHED'
    | 'ROOM_PUBLISHED'
    | 'RESULT_PUBLISHED'
    | 'POOL_PUBLISHED'
    | 'SUBSCRIPTION_CHARGED'
    | 'SUBSCRIPTION_EXPIRED'
    | 'KYC_REQUIRED'
    | 'CUSTOM';
  title?: string;
  body?: string;
  /**
   * Notification-specific event data. Shape intentionally untyped:
   * it varies per `type` (e.g. POOL_PUBLISHED carries a dayKey +
   * totalPool, SUBSCRIPTION_CHARGED carries invoiceNumber + amount).
   * Consumers narrow at the access site.
   */
  payload?: Record<string, unknown>;
  fcmMessageId?: string;
  deliveredAt?: Date;
  readAt?: Date;
}

const NotificationSchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: 'User', index: true }, // null for broadcast
    type: {
      type: String,
      enum: [
        'POST_PUBLISHED',
        'ROOM_PUBLISHED',
        'RESULT_PUBLISHED',
        'POOL_PUBLISHED',
        'SUBSCRIPTION_CHARGED',
        'SUBSCRIPTION_EXPIRED',
        'KYC_REQUIRED',
        'CUSTOM',
      ],
      required: true,
      index: true,
    },
    title: String,
    body: String,
    payload: Schema.Types.Mixed,
    fcmMessageId: String,
    deliveredAt: Date,
    readAt: Date,
  },
  baseSchemaOptions,
);

NotificationSchema.index({ userId: 1, createdAt: -1 }); // user's inbox, newest first

export type NotificationDoc = HydratedDocument<NotificationAttrs>;
export const NotificationModel: Model<NotificationAttrs> = model<NotificationAttrs>(
  'Notification',
  NotificationSchema,
  'notifications',
);
export { NotificationSchema };
