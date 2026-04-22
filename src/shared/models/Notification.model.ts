import {
  Schema,
  model,
  Types,
  type HydratedDocument,
  type InferSchemaType,
  type Model,
} from 'mongoose';
import { baseSchemaOptions } from './_base.js';

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

export type NotificationAttrs = InferSchemaType<typeof NotificationSchema>;
export type NotificationDoc = HydratedDocument<NotificationAttrs>;
export const NotificationModel: Model<NotificationAttrs> = model<NotificationAttrs>(
  'Notification',
  NotificationSchema,
  'notifications',
);
export { NotificationSchema };
