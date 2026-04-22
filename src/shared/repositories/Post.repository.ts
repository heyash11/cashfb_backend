import type { Model } from 'mongoose';
import { PostModel, type PostAttrs } from '../models/Post.model.js';
import { BaseRepository } from './_base.repository.js';

export class PostRepository extends BaseRepository<PostAttrs> {
  constructor(model: Model<PostAttrs> = PostModel) {
    super(model);
  }

  listForDay(dayKey: string, includeDraft = false): Promise<PostAttrs[]> {
    const statusFilter = includeDraft ? {} : { status: { $in: ['SCHEDULED', 'LIVE', 'CLOSED'] } };
    return this.model
      .find({ dayKey, ...statusFilter })
      .sort({ scheduledAt: 1 })
      .lean<PostAttrs[]>()
      .exec();
  }
}
