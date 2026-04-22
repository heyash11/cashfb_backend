import type { Model } from 'mongoose';
import {
  TopDonorRankingModel,
  type TopDonorRankingAttrs,
} from '../models/TopDonorRanking.model.js';
import { BaseRepository } from './_base.repository.js';

export class TopDonorRankingRepository extends BaseRepository<TopDonorRankingAttrs> {
  constructor(model: Model<TopDonorRankingAttrs> = TopDonorRankingModel) {
    super(model);
  }

  topN(limit = 50): Promise<TopDonorRankingAttrs[]> {
    return this.model.find({}).sort({ rank: 1 }).limit(limit).lean<TopDonorRankingAttrs[]>().exec();
  }

  topDonor(): Promise<TopDonorRankingAttrs | null> {
    return this.findOne({ rank: 1 });
  }
}
