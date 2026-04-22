import type { Model } from 'mongoose';
import { AdsConfigModel, type AdsConfigAttrs } from '../models/AdsConfig.model.js';
import { BaseRepository } from './_base.repository.js';

export class AdsConfigRepository extends BaseRepository<AdsConfigAttrs> {
  constructor(model: Model<AdsConfigAttrs> = AdsConfigModel) {
    super(model);
  }

  findByPlacementKey(placementKey: string): Promise<AdsConfigAttrs | null> {
    return this.findOne({ placementKey });
  }

  listEnabled(): Promise<AdsConfigAttrs[]> {
    return this.find({ enabled: true });
  }
}
