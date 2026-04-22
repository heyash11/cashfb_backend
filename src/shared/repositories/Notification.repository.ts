import type { Model, Types } from 'mongoose';
import { NotificationModel, type NotificationAttrs } from '../models/Notification.model.js';
import { BaseRepository } from './_base.repository.js';

export class NotificationRepository extends BaseRepository<NotificationAttrs> {
  constructor(model: Model<NotificationAttrs> = NotificationModel) {
    super(model);
  }

  listForUser(userId: Types.ObjectId | string, limit = 50): Promise<NotificationAttrs[]> {
    return this.model
      .find({ userId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean<NotificationAttrs[]>()
      .exec();
  }
}
