import type { Model, Types } from 'mongoose';
import {
  CoinTransactionModel,
  type CoinTransactionAttrs,
} from '../models/CoinTransaction.model.js';
import { BaseRepository } from './_base.repository.js';

export class CoinTransactionRepository extends BaseRepository<CoinTransactionAttrs> {
  constructor(model: Model<CoinTransactionAttrs> = CoinTransactionModel) {
    super(model);
  }

  listForUser(userId: Types.ObjectId | string, limit = 50): Promise<CoinTransactionAttrs[]> {
    return this.model
      .find({ userId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean<CoinTransactionAttrs[]>()
      .exec();
  }
}
