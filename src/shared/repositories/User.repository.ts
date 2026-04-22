import type { ClientSession, HydratedDocument, Model, Types } from 'mongoose';
import { UserModel, type UserAttrs } from '../models/User.model.js';
import { BaseRepository } from './_base.repository.js';

export class UserRepository extends BaseRepository<UserAttrs> {
  constructor(model: Model<UserAttrs> = UserModel) {
    super(model);
  }

  findByPhone(phone: string): Promise<UserAttrs | null> {
    return this.findOne({ phone });
  }

  findByReferralCode(code: string): Promise<UserAttrs | null> {
    return this.findOne({ referralCode: code });
  }

  /**
   * Single-collection hot path: atomic $inc on coinBalance with the
   * corresponding +totalCoinsEarned bump when awarding. Callers MUST
   * pass a ClientSession so the increment lives inside the same
   * transaction as the matching coin_transactions insert.
   */
  incCoinBalance(
    userId: Types.ObjectId | string,
    delta: number,
    session: ClientSession,
  ): Promise<HydratedDocument<UserAttrs> | null> {
    const inc: Record<string, number> = { coinBalance: delta };
    if (delta > 0) inc['totalCoinsEarned'] = delta;
    return this.model.findByIdAndUpdate(userId, { $inc: inc }, { session, new: true });
  }
}
