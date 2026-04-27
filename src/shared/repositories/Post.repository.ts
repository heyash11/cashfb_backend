import type { Model } from 'mongoose';
import { PostModel, type PostAttrs } from '../models/Post.model.js';
import type { Tier } from '../models/_tier.js';
import { BaseRepository } from './_base.repository.js';

export class PostRepository extends BaseRepository<PostAttrs> {
  constructor(model: Model<PostAttrs> = PostModel) {
    super(model);
  }

  /**
   * @deprecated Phase 11.4 — use `listForDayAndTier`. Returns posts
   * across all tiers for a dayKey, which is incorrect under the
   * parallel-tier model. Retained for admin-only call sites until
   * Phase 11.5 cleanup batch.
   */
  listForDay(dayKey: string, includeDraft = false): Promise<PostAttrs[]> {
    const statusFilter = includeDraft ? {} : { status: { $in: ['SCHEDULED', 'LIVE', 'CLOSED'] } };
    return this.model
      .find({ dayKey, ...statusFilter })
      .sort({ scheduledAt: 1 })
      .lean<PostAttrs[]>()
      .exec();
  }

  /**
   * Phase 11.4 — tier-scoped daily feed. Backed by the
   * `{tier, dayKey, status, scheduledAt}` compound index.
   */
  listForDayAndTier(dayKey: string, tier: Tier, includeDraft = false): Promise<PostAttrs[]> {
    const statusFilter = includeDraft ? {} : { status: { $in: ['SCHEDULED', 'LIVE', 'CLOSED'] } };
    return this.model
      .find({ tier, dayKey, ...statusFilter })
      .sort({ scheduledAt: 1 })
      .lean<PostAttrs[]>()
      .exec();
  }
}
