import type { HydratedDocument, Model, Types } from 'mongoose';
import {
  DeviceFingerprintModel,
  type DeviceFingerprintAttrs,
} from '../models/DeviceFingerprint.model.js';
import { BaseRepository, type WriteOpts } from './_base.repository.js';

export class DeviceFingerprintRepository extends BaseRepository<DeviceFingerprintAttrs> {
  constructor(model: Model<DeviceFingerprintAttrs> = DeviceFingerprintModel) {
    super(model);
  }

  findByFingerprint(fingerprint: string): Promise<DeviceFingerprintAttrs | null> {
    return this.findOne({ fingerprint });
  }

  /**
   * Upsert the fingerprint row and append `userId` to `linkedUserIds`
   * atomically. Single-collection hot path used by signup after a
   * successful user create. `$addToSet` keeps the linkage idempotent
   * if the same user signs back in from the same device.
   */
  upsertAndLinkUser(
    fingerprint: string,
    userId: Types.ObjectId,
    opts: WriteOpts = {},
  ): Promise<HydratedDocument<DeviceFingerprintAttrs> | null> {
    return this.model.findOneAndUpdate(
      { fingerprint },
      {
        $setOnInsert: { fingerprint, firstSeenUserId: userId },
        $addToSet: { linkedUserIds: userId },
      },
      { ...opts, upsert: true, new: true },
    );
  }

  incrementSuspiciousScore(fingerprint: string, delta: number, opts: WriteOpts = {}) {
    return this.updateOne({ fingerprint }, { $inc: { suspiciousScore: delta } }, opts);
  }
}
