import type { Model } from 'mongoose';
import { PrizePoolModel, type PrizePoolAttrs } from '../models/PrizePool.model.js';
import type { Tier } from '../models/_tier.js';
import { BaseRepository } from './_base.repository.js';

export class PrizePoolRepository extends BaseRepository<PrizePoolAttrs> {
  constructor(model: Model<PrizePoolAttrs> = PrizePoolModel) {
    super(model);
  }

  /**
   * Phase 11.2 — exact-key fetch via the {tier, dayKey} unique
   * index from Phase 11.0. Used by the cron handler's per-tier
   * idempotency check and by the admin "today's pool for tier X"
   * read paths.
   *
   * (The legacy `findByDay(dayKey)` was removed in Phase 11.4 —
   * it was bug-prone under the per-tier model since it returned
   * whichever Mongo's natural order surfaced first.)
   */
  findByTierDayKey(tier: Tier, dayKey: string): Promise<PrizePoolAttrs | null> {
    return this.findOne({ tier, dayKey });
  }
}
