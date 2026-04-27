import type { Model } from 'mongoose';
import { CustomRoomModel, type CustomRoomAttrs } from '../models/CustomRoom.model.js';
import type { Tier } from '../models/_tier.js';
import { BaseRepository } from './_base.repository.js';

export class CustomRoomRepository extends BaseRepository<CustomRoomAttrs> {
  constructor(model: Model<CustomRoomAttrs> = CustomRoomModel) {
    super(model);
  }

  /**
   * @deprecated Phase 11.4 — use `listForDayAndTier`. The non-tier-
   * scoped variant returns rooms across all tiers, which is incorrect
   * under the parallel-tier model. Retained for one cleanup chunk.
   */
  listForDay(
    dayKey: string,
    game: 'BGMI' | 'FF',
    page = 1,
    pageSize = 8,
  ): Promise<CustomRoomAttrs[]> {
    return this.model
      .find({ dayKey, game })
      .sort({ scheduledAt: 1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean<CustomRoomAttrs[]>()
      .exec();
  }

  /**
   * Phase 11.4 — tier-scoped daily feed. Backed by the
   * `{tier, dayKey, game, scheduledAt}` compound index.
   */
  listForDayAndTier(
    dayKey: string,
    tier: Tier,
    game: 'BGMI' | 'FF',
    page = 1,
    pageSize = 8,
  ): Promise<CustomRoomAttrs[]> {
    return this.model
      .find({ tier, dayKey, game })
      .sort({ scheduledAt: 1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean<CustomRoomAttrs[]>()
      .exec();
  }
}
