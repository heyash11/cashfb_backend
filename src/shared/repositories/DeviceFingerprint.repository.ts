import type { Model } from 'mongoose';
import {
  DeviceFingerprintModel,
  type DeviceFingerprintAttrs,
} from '../models/DeviceFingerprint.model.js';
import { BaseRepository } from './_base.repository.js';

export class DeviceFingerprintRepository extends BaseRepository<DeviceFingerprintAttrs> {
  constructor(model: Model<DeviceFingerprintAttrs> = DeviceFingerprintModel) {
    super(model);
  }

  findByFingerprint(fingerprint: string): Promise<DeviceFingerprintAttrs | null> {
    return this.findOne({ fingerprint });
  }
}
