import mongoose, { type FilterQuery, type Types } from 'mongoose';
import { InternalError, NotFoundError, ValidationError } from '../../shared/errors/AppError.js';
import { CoinTransactionModel } from '../../shared/models/CoinTransaction.model.js';
import { UserModel, type UserAttrs } from '../../shared/models/User.model.js';
import { CoinTransactionRepository } from '../../shared/repositories/CoinTransaction.repository.js';
import { UserRepository } from '../../shared/repositories/User.repository.js';
import { ForceLogoutStore } from '../../shared/services/force-logout.js';

export interface AdminUsersListFilter {
  search?: string;
  tier?: UserAttrs['tier'];
  blocked?: boolean;
}

export interface AdminUsersListResult {
  items: UserAttrs[];
}

export interface CoinAdjustInput {
  userId: Types.ObjectId;
  delta: number; // signed int, non-zero
  reason: string;
  actorId: Types.ObjectId;
}

export interface CoinAdjustResult {
  balanceBefore: number;
  balanceAfter: number;
  delta: number;
  coinTxId: Types.ObjectId;
}

export interface AdminUsersServiceDeps {
  userRepo?: UserRepository;
  coinTxRepo?: CoinTransactionRepository;
  forceLogoutStore?: ForceLogoutStore;
}

/**
 * Admin operations on User entities. Phase 8 Chunk 3a.
 *
 * Every write accepts an `actorId` so the caller (HTTP controller +
 * auditLog middleware) can stamp the admin identity. The service
 * itself does not write AuditLog rows — that's the middleware's
 * job. What the service IS responsible for:
 *   - atomic Mongo writes (coin adjust runs under a transaction,
 *     pairing the balance $inc with a coin_transactions insert).
 *   - Redis force-logout cutoff on forceLogout().
 *   - blocked subdoc structure on block/unblock.
 *
 * Search is phone-prefix-based (plus email fallback). The user
 * search surface is deliberately narrow — admins look up a specific
 * user by a known identifier, not browse.
 */
export class AdminUsersService {
  private readonly userRepo: UserRepository;
  private readonly coinTxRepo: CoinTransactionRepository;
  private readonly forceLogoutStore: ForceLogoutStore;

  constructor(deps: AdminUsersServiceDeps = {}) {
    this.userRepo = deps.userRepo ?? new UserRepository();
    this.coinTxRepo = deps.coinTxRepo ?? new CoinTransactionRepository();
    this.forceLogoutStore = deps.forceLogoutStore ?? new ForceLogoutStore();
  }

  async list(filter: AdminUsersListFilter, limit = 50): Promise<AdminUsersListResult> {
    const q: FilterQuery<UserAttrs> = {};
    if (filter.tier) q.tier = filter.tier;
    if (typeof filter.blocked === 'boolean') q['blocked.isBlocked'] = filter.blocked;
    if (filter.search) {
      // Narrow search: exact phone, phone prefix, or exact email.
      const s = filter.search.trim();
      q.$or = [
        { phone: s },
        { phone: { $regex: `^${escapeRegex(s)}`, $options: 'i' } },
        { email: s.toLowerCase() },
      ];
    }
    const items = await this.userRepo.find(q, {
      sort: { createdAt: -1 },
      limit: Math.max(1, Math.min(200, limit)),
    });
    return { items };
  }

  async getForAudit(userId: Types.ObjectId | string): Promise<UserAttrs | null> {
    return this.userRepo.findById(userId);
  }

  async block(userId: Types.ObjectId, reason: string, actorId: Types.ObjectId): Promise<UserAttrs> {
    const updated = await this.userRepo.findOneAndUpdate(
      { _id: userId },
      {
        $set: {
          'blocked.isBlocked': true,
          'blocked.reason': reason,
          'blocked.at': new Date(),
          'blocked.by': actorId,
        },
      },
    );
    if (!updated) throw new NotFoundError('User not found');
    return updated;
  }

  async unblock(userId: Types.ObjectId, _actorId: Types.ObjectId): Promise<UserAttrs> {
    const updated = await this.userRepo.findOneAndUpdate(
      { _id: userId },
      {
        $set: {
          'blocked.isBlocked': false,
        },
        $unset: {
          'blocked.reason': '',
          'blocked.at': '',
          'blocked.by': '',
        },
      },
    );
    if (!updated) throw new NotFoundError('User not found');
    return updated;
  }

  /**
   * Transactional coin-adjust. Pairs a `User.coinBalance` $inc with a
   * `coin_transactions` insert so a balance mutation without a
   * matching audit row (or vice-versa) cannot occur. `min: 0` on the
   * coinBalance field means a debit that would overdraft fails at
   * the driver level — we translate that into ValidationError.
   */
  async adjustCoins(input: CoinAdjustInput): Promise<CoinAdjustResult> {
    if (input.delta === 0) throw new ValidationError('delta must not be zero');

    const session = await mongoose.startSession();
    try {
      let result: CoinAdjustResult | null = null;

      await session.withTransaction(async () => {
        const user = await UserModel.findOneAndUpdate(
          { _id: input.userId },
          { $inc: { coinBalance: input.delta } },
          { new: true, session },
        );
        if (!user) throw new NotFoundError('User not found');

        const before = user.coinBalance - input.delta;
        const after = user.coinBalance;

        const [txDoc] = await CoinTransactionModel.create(
          [
            {
              userId: input.userId,
              type: input.delta > 0 ? 'ADMIN_CREDIT' : 'ADMIN_DEBIT',
              amount: input.delta,
              balanceAfter: after,
              reference: { kind: 'Admin', id: input.actorId },
              reason: input.reason,
            },
          ],
          { session },
        );
        if (!txDoc) {
          throw new InternalError('COIN_TX_INSERT', 'coin transaction insert returned empty');
        }

        result = {
          balanceBefore: before,
          balanceAfter: after,
          delta: input.delta,
          coinTxId: txDoc._id,
        };
      });

      if (!result) {
        throw new InternalError('COIN_TX_INVARIANT', 'coin adjust produced no result');
      }
      return result;
    } catch (err) {
      // `min: 0` validator fires as a Mongoose ValidationError when the
      // debit would overdraft. Translate to our AppError so the envelope
      // renders a 400 instead of a 500.
      if (err instanceof mongoose.Error.ValidationError) {
        throw new ValidationError('Coin adjustment would leave balance below zero', {
          delta: input.delta,
        });
      }
      throw err;
    } finally {
      await session.endSession();
    }
  }

  /**
   * Set the force-logout cutoff for this user. Returns the cutoff
   * (unix seconds) so the caller can surface it in the audit log.
   * The next requireUser hit from this user — for any access token
   * issued before the cutoff — returns 401 SESSION_FORCIBLY_TERMINATED.
   */
  async forceLogout(userId: Types.ObjectId): Promise<{ cutoff: number }> {
    const user = await this.userRepo.findById(userId);
    if (!user) throw new NotFoundError('User not found');
    const cutoff = await this.forceLogoutStore.forceLogout(String(userId));
    return { cutoff };
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
