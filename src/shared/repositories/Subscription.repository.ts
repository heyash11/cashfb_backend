import type { Model, Types } from 'mongoose';
import { SubscriptionModel, type SubscriptionAttrs } from '../models/Subscription.model.js';
import { BaseRepository } from './_base.repository.js';

export class SubscriptionRepository extends BaseRepository<SubscriptionAttrs> {
  constructor(model: Model<SubscriptionAttrs> = SubscriptionModel) {
    super(model);
  }

  findByRazorpayId(razorpaySubscriptionId: string): Promise<SubscriptionAttrs | null> {
    return this.findOne({ razorpaySubscriptionId });
  }

  findActiveForUser(userId: Types.ObjectId | string): Promise<SubscriptionAttrs | null> {
    return this.findOne({ userId, status: { $in: ['ACTIVE', 'AUTHENTICATED'] } });
  }
}
