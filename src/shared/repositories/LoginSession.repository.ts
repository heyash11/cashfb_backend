import type { Model, Types, UpdateWriteOpResult } from 'mongoose';
import { LoginSessionModel, type LoginSessionAttrs } from '../models/LoginSession.model.js';
import { BaseRepository, type WriteOpts } from './_base.repository.js';

export class LoginSessionRepository extends BaseRepository<LoginSessionAttrs> {
  constructor(model: Model<LoginSessionAttrs> = LoginSessionModel) {
    super(model);
  }

  findActiveByRefreshHash(refreshTokenHash: string): Promise<LoginSessionAttrs | null> {
    return this.findOne({ refreshTokenHash, revokedAt: { $exists: false } });
  }

  findByJti(jti: string): Promise<LoginSessionAttrs | null> {
    return this.findOne({ jti });
  }

  listActiveForUser(userId: Types.ObjectId | string): Promise<LoginSessionAttrs[]> {
    return this.find({ userId, revokedAt: { $exists: false } });
  }

  /**
   * Reuse-detection primitive (SECURITY.md §1). Revokes every session
   * in the family when a revoked-family token is presented.
   */
  revokeFamily(family: string, opts: WriteOpts = {}): Promise<UpdateWriteOpResult> {
    return this.updateMany(
      { family, revokedAt: { $exists: false } },
      { $set: { revokedAt: new Date() } },
      opts,
    );
  }

  revokeByJti(jti: string, opts: WriteOpts = {}): Promise<UpdateWriteOpResult> {
    return this.updateOne({ jti }, { $set: { revokedAt: new Date() } }, opts);
  }
}
