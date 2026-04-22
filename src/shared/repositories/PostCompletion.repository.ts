import type { HydratedDocument, Model, Types } from 'mongoose';
import { PostCompletionModel, type PostCompletionAttrs } from '../models/PostCompletion.model.js';
import { BaseRepository, isDuplicateKeyError, type WriteOpts } from './_base.repository.js';

export class PostCompletionRepository extends BaseRepository<PostCompletionAttrs> {
  constructor(model: Model<PostCompletionAttrs> = PostCompletionModel) {
    super(model);
  }

  findByUserPost(
    userId: Types.ObjectId | string,
    postId: Types.ObjectId | string,
  ): Promise<PostCompletionAttrs | null> {
    return this.findOne({ userId, postId });
  }

  /**
   * Idempotent insert. If the unique {userId, postId} index rejects
   * the write, return null. Callers (coin service in Phase 3) use
   * this inside a transaction to decide whether to award the coin.
   */
  async insertIfAbsent(
    data: Partial<PostCompletionAttrs>,
    opts: WriteOpts,
  ): Promise<HydratedDocument<PostCompletionAttrs> | null> {
    try {
      return await this.create(data, opts);
    } catch (err) {
      if (isDuplicateKeyError(err)) return null;
      throw err;
    }
  }
}
