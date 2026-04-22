import type { HydratedDocument, Model, Types } from 'mongoose';
import { RedeemCodeModel, type RedeemCodeAttrs } from '../models/RedeemCode.model.js';
import { BaseRepository, type WriteOpts } from './_base.repository.js';

export class RedeemCodeRepository extends BaseRepository<RedeemCodeAttrs> {
  constructor(model: Model<RedeemCodeAttrs> = RedeemCodeModel) {
    super(model);
  }

  /**
   * The FCFS primitive (CLAUDE.md §0.3). Exactly one concurrent caller
   * sees the returned doc; every other caller sees null and should
   * surface a 409 CODE_TAKEN. Do NOT invent a queue or lottery around
   * this.
   */
  atomicFcfsClaim(
    codeId: Types.ObjectId | string,
    userId: Types.ObjectId | string,
    opts: WriteOpts = {},
  ): Promise<HydratedDocument<RedeemCodeAttrs> | null> {
    return this.findOneAndUpdate(
      { _id: codeId, status: 'PUBLISHED' },
      {
        $set: { status: 'COPIED', firstCopiedBy: userId, firstCopiedAt: new Date() },
        $inc: { copyCount: 1 },
      },
      opts,
    );
  }

  findByHash(codeHash: string): Promise<RedeemCodeAttrs | null> {
    return this.findOne({ codeHash });
  }

  listAvailableForBatch(batchId: Types.ObjectId | string, limit = 100): Promise<RedeemCodeAttrs[]> {
    return this.model
      .find({ batchId, status: 'AVAILABLE' })
      .limit(limit)
      .lean<RedeemCodeAttrs[]>()
      .exec();
  }
}
