import type { Model } from 'mongoose';
import { PrizePoolModel, type PrizePoolAttrs } from '../models/PrizePool.model.js';
import type { Tier } from '../models/_tier.js';
import { BaseRepository } from './_base.repository.js';

export class PrizePoolRepository extends BaseRepository<PrizePoolAttrs> {
  constructor(model: Model<PrizePoolAttrs> = PrizePoolModel) {
    super(model);
  }

  /**
   * @deprecated Phase 11.2 — under the per-tier model there are
   * three rows per dayKey (one per tier). `findByDay` returns
   * whichever Mongo's natural order surfaces first, which is bug-
   * prone. Use `findByTierDayKey(tier, dayKey)` for an exact-key
   * fetch. Retained without active callers; cleanup in Phase 11.4.
   */
  findByDay(dayKey: string): Promise<PrizePoolAttrs | null> {
    return this.findOne({ dayKey });
  }

  /**
   * Phase 11.2 — exact-key fetch via the {tier, dayKey} unique
   * index from Phase 11.0. Used by the cron handler's per-tier
   * idempotency check and by the admin "today's pool for tier X"
   * read paths.
   */
  findByTierDayKey(tier: Tier, dayKey: string): Promise<PrizePoolAttrs | null> {
    return this.findOne({ tier, dayKey });
  }
}
