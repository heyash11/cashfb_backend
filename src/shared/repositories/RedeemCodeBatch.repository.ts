import type { Model } from 'mongoose';
import {
  RedeemCodeBatchModel,
  type RedeemCodeBatchAttrs,
} from '../models/RedeemCodeBatch.model.js';
import { BaseRepository } from './_base.repository.js';

export class RedeemCodeBatchRepository extends BaseRepository<RedeemCodeBatchAttrs> {
  constructor(model: Model<RedeemCodeBatchAttrs> = RedeemCodeBatchModel) {
    super(model);
  }
}
