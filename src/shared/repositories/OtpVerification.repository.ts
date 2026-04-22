import type { Model, UpdateWriteOpResult } from 'mongoose';
import {
  OtpVerificationModel,
  type OtpVerificationAttrs,
} from '../models/OtpVerification.model.js';
import { BaseRepository, type WriteOpts } from './_base.repository.js';

export class OtpVerificationRepository extends BaseRepository<OtpVerificationAttrs> {
  constructor(model: Model<OtpVerificationAttrs> = OtpVerificationModel) {
    super(model);
  }

  /** Latest non-consumed, non-expired OTP for this destination. */
  findActive(destination: string): Promise<OtpVerificationAttrs | null> {
    return this.model
      .findOne({
        destination,
        consumedAt: { $exists: false },
        expiresAt: { $gt: new Date() },
      })
      .sort({ createdAt: -1 })
      .lean<OtpVerificationAttrs>()
      .exec();
  }

  incrementAttempts(destination: string, opts: WriteOpts = {}): Promise<UpdateWriteOpResult> {
    return this.updateOne(
      { destination, consumedAt: { $exists: false } },
      { $inc: { attempts: 1 } },
      opts,
    );
  }
}
