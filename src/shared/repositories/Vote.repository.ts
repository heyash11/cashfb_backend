import type { HydratedDocument, Model, Types } from 'mongoose';
import { VoteModel, type VoteAttrs } from '../models/Vote.model.js';
import type { Tier } from '../models/_tier.js';
import { BaseRepository, isDuplicateKeyError, type WriteOpts } from './_base.repository.js';

export class VoteRepository extends BaseRepository<VoteAttrs> {
  constructor(model: Model<VoteAttrs> = VoteModel) {
    super(model);
  }

  /**
   * @deprecated Phase 11.1 — use `findByUserDayTier` instead.
   * Returns the first matching vote across any tier for the day,
   * which is incorrect under the parallel-tier model. Retained for
   * one cleanup chunk so backfill / migration tools that don't yet
   * pass tier still compile; remove in Phase 11.4.
   */
  findByUserDay(userId: Types.ObjectId | string, dayKey: string): Promise<VoteAttrs | null> {
    return this.findOne({ userId, dayKey });
  }

  /**
   * Phase 11.1 — tier-scoped lookup. The {userId, tier, dayKey}
   * unique index makes this an exact-key fetch.
   */
  findByUserDayTier(
    userId: Types.ObjectId | string,
    tier: Tier,
    dayKey: string,
  ): Promise<VoteAttrs | null> {
    return this.findOne({ userId, tier, dayKey });
  }

  /**
   * Idempotent insert. The unique {userId, tier, dayKey} index
   * (Phase 11.0) enforces the once-per-tier-per-day rule at the DB
   * level. A duplicate insert returns null here instead of throwing,
   * so the service layer can return 409 VOTE_ALREADY_CAST cleanly.
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
