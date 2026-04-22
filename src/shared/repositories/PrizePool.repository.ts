import type { Model } from 'mongoose';
import { PrizePoolModel, type PrizePoolAttrs } from '../models/PrizePool.model.js';
import { BaseRepository } from './_base.repository.js';

export class PrizePoolRepository extends BaseRepository<PrizePoolAttrs> {
  constructor(model: Model<PrizePoolAttrs> = PrizePoolModel) {
    super(model);
  }

  findByDay(dayKey: string): Promise<PrizePoolAttrs | null> {
    return this.findOne({ dayKey });
  }
}
