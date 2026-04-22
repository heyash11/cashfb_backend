import type { HydratedDocument, Model, Types } from 'mongoose';
import { VoteModel, type VoteAttrs } from '../models/Vote.model.js';
import { BaseRepository, isDuplicateKeyError, type WriteOpts } from './_base.repository.js';

export class VoteRepository extends BaseRepository<VoteAttrs> {
  constructor(model: Model<VoteAttrs> = VoteModel) {
    super(model);
  }

  findByUserDay(userId: Types.ObjectId | string, dayKey: string): Promise<VoteAttrs | null> {
    return this.findOne({ userId, dayKey });
  }

  /**
   * Idempotent insert. The unique {userId, dayKey} index enforces the
   * once-per-day rule at the DB level (CLAUDE.md §0.4). A duplicate
   * insert returns null here instead of throwing, so the service layer
   * can return 409 VOTE_ALREADY_CAST cleanly.
   */
  async insertIfAbsent(
    data: Partial<VoteAttrs>,
    opts: WriteOpts,
  ): Promise<HydratedDocument<VoteAttrs> | null> {
    try {
      return await this.create(data, opts);
    } catch (err) {
      if (isDuplicateKeyError(err)) return null;
      throw err;
    }
  }

  countForDay(dayKey: string): Promise<number> {
    return this.count({ dayKey });
  }
}
