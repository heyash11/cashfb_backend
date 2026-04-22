import type { Model, Types } from 'mongoose';
import {
  SubscriptionPaymentModel,
  type SubscriptionPaymentAttrs,
} from '../models/SubscriptionPayment.model.js';
import { BaseRepository } from './_base.repository.js';

export class SubscriptionPaymentRepository extends BaseRepository<SubscriptionPaymentAttrs> {
  constructor(model: Model<SubscriptionPaymentAttrs> = SubscriptionPaymentModel) {
    super(model);
  }

  findByRazorpayPaymentId(razorpayPaymentId: string): Promise<SubscriptionPaymentAttrs | null> {
    return this.findOne({ razorpayPaymentId });
  }

  listForSubscription(
    subscriptionId: Types.ObjectId | string,
  ): Promise<SubscriptionPaymentAttrs[]> {
    return this.model
      .find({ subscriptionId })
      .sort({ capturedAt: -1 })
      .lean<SubscriptionPaymentAttrs[]>()
      .exec();
  }
}
