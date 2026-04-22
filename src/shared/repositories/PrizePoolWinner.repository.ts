import type { Model, Types } from 'mongoose';
import {
  PrizePoolWinnerModel,
  type PrizePoolWinnerAttrs,
} from '../models/PrizePoolWinner.model.js';
import { BaseRepository } from './_base.repository.js';

export class PrizePoolWinnerRepository extends BaseRepository<PrizePoolWinnerAttrs> {
  constructor(model: Model<PrizePoolWinnerAttrs> = PrizePoolWinnerModel) {
    super(model);
  }

  listForDay(dayKey: string): Promise<PrizePoolWinnerAttrs[]> {
    return this.find({ dayKey });
  }

  listForUser(userId: Types.ObjectId | string): Promise<PrizePoolWinnerAttrs[]> {
    return this.find({ userId });
  }
}
