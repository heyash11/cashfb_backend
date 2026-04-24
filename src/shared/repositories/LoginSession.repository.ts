import type { DeleteResult, Model, Types, UpdateWriteOpResult } from 'mongoose';
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

  /**
   * DPDP erasure primitive (Phase 9 Chunk 4). Revokes every active
   * session for a user at once — used when the user requests
   * erasure. Pairs with a force-logout denylist write so any still-
   * valid access token (15 min TTL) is also rejected.
   */
  revokeAllForUser(
    userId: Types.ObjectId | string,
    opts: WriteOpts = {},
  ): Promise<UpdateWriteOpResult> {
    return this.updateMany(
      { userId, revokedAt: { $exists: false } },
      { $set: { revokedAt: new Date() } },
      opts,
    );
  }

  /**
   * DPDP anonymization primitive (Phase 9 Chunk 4). Deletes every
   * session row (revoked or not) for the user. Called inside the
   * anonymization transaction so all per-user session state is
   * purged in lockstep with the PII tombstoning.
   */
  deleteAllForUser(userId: Types.ObjectId | string, opts: WriteOpts = {}): Promise<DeleteResult> {
    return this.deleteMany({ userId }, opts);
  }
}
