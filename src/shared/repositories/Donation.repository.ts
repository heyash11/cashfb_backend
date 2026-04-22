import type { HydratedDocument, Model } from 'mongoose';
import { DonationModel, type DonationAttrs } from '../models/Donation.model.js';
import { BaseRepository, type WriteOpts } from './_base.repository.js';

export class DonationRepository extends BaseRepository<DonationAttrs> {
  constructor(model: Model<DonationAttrs> = DonationModel) {
    super(model);
  }

  findByOrderId(razorpayOrderId: string): Promise<DonationAttrs | null> {
    return this.findOne({ razorpayOrderId });
  }

  /**
   * Webhook idempotency: flip to CAPTURED only if still CREATED. No-op
   * if already captured (safe to replay).
   */
  markCapturedIfPending(
    razorpayOrderId: string,
    razorpayPaymentId: string,
    opts: WriteOpts = {},
  ): Promise<HydratedDocument<DonationAttrs> | null> {
    return this.findOneAndUpdate(
      { razorpayOrderId, status: 'CREATED' },
      { $set: { status: 'CAPTURED', razorpayPaymentId, capturedAt: new Date() } },
      opts,
    );
  }
}
