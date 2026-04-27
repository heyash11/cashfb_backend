import mongoose, { type Types } from 'mongoose';
import {
  ConflictError,
  ForbiddenError,
  InternalError,
  PaymentRequiredError,
  UnauthorizedError,
} from '../../shared/errors/AppError.js';
import type { CoinEventEmitter } from '../../shared/events/coinEvents.js';
import { userCanAccessTier, type Tier } from '../../shared/models/_tier.js';
import { CoinTransactionRepository } from '../../shared/repositories/CoinTransaction.repository.js';
import { UserRepository } from '../../shared/repositories/User.repository.js';
import { VoteRepository } from '../../shared/repositories/Vote.repository.js';
import { dayKeyIst, nowIst } from '../../shared/utils/date.js';

const VOTE_COST = 3;

export interface VoteServiceDeps {
  coinEvents: CoinEventEmitter;
  voteRepo?: VoteRepository;
  userRepo?: UserRepository;
  coinTxRepo?: CoinTransactionRepository;
}

export class VoteService {
  private readonly coinEvents: CoinEventEmitter;
  private readonly voteRepo: VoteRepository;
  private readonly userRepo: UserRepository;
  private readonly coinTxRepo: CoinTransactionRepository;

  constructor(deps: VoteServiceDeps) {
    this.coinEvents = deps.coinEvents;
    this.voteRepo = deps.voteRepo ?? new VoteRepository();
    this.userRepo = deps.userRepo ?? new UserRepository();
    this.coinTxRepo = deps.coinTxRepo ?? new CoinTransactionRepository();
  }

  /**
   * Cast a once-per-tier-per-day vote.
   *
   * Phase 11.1 added the `tier` parameter and snapshotted it onto
   * the Vote row; Phase 11.0's `{userId, tier, dayKey}` unique
   * index makes per-tier dedup automatic.
   *
   * Phase 11.4 — auth flipped from hierarchical (`tierGrantsAccess`)
   * to STRICT subscription-based (`userCanAccessTier(subscriptions,
   * tier, now)`). A PRO_MAX-only subscriber can NOT vote in PRO;
   * each tier section requires its own paid subscription.
   *
   * Error order (CONVENTIONS.md §HTTP error layering):
   *   - 400 ValidationError       (Zod, controller layer)
   *   - 401 UnauthorizedError      (user not found)
   *   - 403 USER_BLOCKED           (admin-block)
   *   - 403 TIER_NOT_ACCESSIBLE    (auth before payment)
   *   - 402 INSUFFICIENT_COINS     (balance + admin-block race)
   *   - 409 VOTE_ALREADY_CAST      (mongo dup key on the tier slot)
   */
  async castVote(input: {
    userId: Types.ObjectId;
    tier: Tier;
    target: string;
    ipAddress: string;
    deviceFingerprint: string | null;
  }): Promise<{ coinBalance: number; dayKey: string; tier: Tier }> {
    const dayKey = dayKeyIst(nowIst());

    const user = await this.userRepo.findById(input.userId);
    if (!user) throw new UnauthorizedError('User not found');
    if (user.blocked.isBlocked) {
      throw new ForbiddenError('USER_BLOCKED', 'Account is blocked');
    }
    if (!userCanAccessTier(user.subscriptions ?? [], input.tier, new Date())) {
      throw new ForbiddenError(
        'TIER_NOT_ACCESSIBLE',
        `Subscription required to vote in ${input.tier}`,
      );
    }
    if (user.coinBalance < VOTE_COST) {
      throw new PaymentRequiredError('INSUFFICIENT_COINS', `Need ${VOTE_COST} coins to vote`);
    }

    const session = await mongoose.startSession();
    try {
      const result = await session.withTransaction<{
        coinBalance: number;
        dayKey: string;
        tier: Tier;
      }>(async () => {
        // Pattern 2 (CONVENTIONS.md "Transactions — pitfalls and patterns"):
        // terminal throw on duplicate. Transaction is intended to abort and
        // trigger VOTE_ALREADY_CAST. No continuation after this write.
        const voteData: Record<string, unknown> = {
          userId: input.userId,
          dayKey,
          tier: input.tier,
          target: input.target,
          coinsSpent: VOTE_COST,
          ipAddress: input.ipAddress,
        };
        if (input.deviceFingerprint) voteData['device'] = input.deviceFingerprint;

        const vote = await this.voteRepo.insertIfAbsent(voteData, { session });
        if (!vote) {
          throw new ConflictError('VOTE_ALREADY_CAST', 'Already voted in this tier today');
        }

        // Atomic decrement with compound guard: balance AND not blocked.
        // Defends against the admin-block race between pre-read and this
        // write. modifiedCount === 0 means either condition failed.
        const updated = await this.userRepo.findOneAndUpdate(
          {
            _id: input.userId,
            coinBalance: { $gte: VOTE_COST },
            'blocked.isBlocked': { $ne: true },
          },
          {
            $inc: { coinBalance: -VOTE_COST, totalVotesCast: 1 },
            $set: { lastVoteDate: dayKey },
          },
          { session },
        );
        if (!updated) {
          throw new PaymentRequiredError('INSUFFICIENT_COINS', `Need ${VOTE_COST} coins to vote`);
        }

        await this.coinTxRepo.create(
          {
            userId: input.userId,
            type: 'VOTE_SPEND',
            amount: -VOTE_COST,
            balanceAfter: updated.coinBalance,
            reference: { kind: 'Vote', id: vote._id },
          },
          { session },
        );

        return { coinBalance: updated.coinBalance, dayKey, tier: input.tier };
      });

      if (!result) {
        throw new InternalError('VOTE_FAILED', 'transaction produced no result');
      }

      await this.coinEvents.emitCoinsUpdated({
        userId: input.userId,
        coinBalance: result.coinBalance,
        reason: 'VOTE_SPEND',
      });

      return result;
    } finally {
      await session.endSession();
    }
  }

  /**
   * Today's vote status for the home feed's "vote" card, scoped to
   * a tier section (Phase 11.1).
   *
   * Access-blind by design: returns `canVote:true` for any empty
   * slot regardless of the caller's subscription. The cast
   * endpoint enforces TIER_NOT_ACCESSIBLE at write time. This
   * separation lets the UI render slot occupancy ("you have a
   * vote pending in PRO_MAX") without a secondary auth call.
   *
   * `tier` is optional on the wire (defaults to 'PUBLIC' for pre-
   * 11.1 client backwards compat) but always echoed back in the
   * response so the client can render the correct slot's eligibility
   * unambiguously (§A7 / §R1 — required field on response).
   *
   * Returns `canVote: false` if there's already a vote for THIS
   * tier on today's dayKey, `canVote: true` otherwise. Per-tier
   * slots are independent — voting in PUBLIC doesn't affect PRO
   * eligibility, etc.
   */
  async getTodayStatus(
    userId: Types.ObjectId,
    tier: Tier = 'PUBLIC',
  ): Promise<{ canVote: boolean; usedAt?: Date; dayKey: string; tier: Tier }> {
    const dayKey = dayKeyIst(nowIst());
    const vote = await this.voteRepo.findByUserDayTier(userId, tier, dayKey);
    if (vote) {
      return { canVote: false, usedAt: vote.createdAt, dayKey, tier };
    }
    return { canVote: true, dayKey, tier };
  }
}
