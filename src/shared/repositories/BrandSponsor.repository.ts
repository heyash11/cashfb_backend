import type { Model } from 'mongoose';
import { BrandSponsorModel, type BrandSponsorAttrs } from '../models/BrandSponsor.model.js';
import { BaseRepository } from './_base.repository.js';

export class BrandSponsorRepository extends BaseRepository<BrandSponsorAttrs> {
  constructor(model: Model<BrandSponsorAttrs> = BrandSponsorModel) {
    super(model);
  }

  /** Three active slots in priority order for the home feed. */
  listActiveForHome(): Promise<BrandSponsorAttrs[]> {
    return this.model
      .find({ status: 'ACTIVE' })
      .sort({ slot: 1, priority: -1 })
      .lean<BrandSponsorAttrs[]>()
      .exec();
  }
}
