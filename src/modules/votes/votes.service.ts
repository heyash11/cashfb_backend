import mongoose, { type Types } from 'mongoose';
import {
  ConflictError,
  ForbiddenError,
  InternalError,
  PaymentRequiredError,
  UnauthorizedError,
} from '../../shared/errors/AppError.js';
import type { CoinEventEmitter } from '../../shared/events/coinEvents.js';
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
   * Cast a once-per-day vote. See docs/BUILD_PLAN.md §Phase 3 +
   * CONVENTIONS.md §Transactions — pitfalls and patterns.
   *
   * Pre-transaction (fast-reject, no writes):
   *   - UnauthorizedError if the user can't be found (token outlived user).
   *   - ForbiddenError 'USER_BLOCKED' if the user is blocked.
   *   - PaymentRequiredError 'INSUFFICIENT_COINS' if balance < VOTE_COST.
   *
   * Transaction (pattern 2 per CONVENTIONS.md — terminal throw on
   * duplicate, no continuation):
   *   1. voteRepo.insertIfAbsent(...) — duplicate → throw
   *      'VOTE_ALREADY_CAST'. Transaction aborts by design.
   *   2. userRepo.findOneAndUpdate with compound guard (balance + not
   *      blocked). modifiedCount === 0 → throw 'INSUFFICIENT_COINS'
   *      (this also catches the admin-block race between pre-read
   *      and this write — blocked users surface as
   *      INSUFFICIENT_COINS on the losing write; a retry hits the
   *      pre-read block-check and surfaces USER_BLOCKED).
   *   3. Insert coin_transactions VOTE_SPEND with balanceAfter and
   *      reference.id = vote._id.
   *   4. Commit.
   *
   * Post-transaction:
   *   - Emit coins.updated.
   */
  async castVote(input: {
    userId: Types.ObjectId;
    target: string;
    ipAddress: string;
    deviceFingerprint: string | null;
  }): Promise<{ coinBalance: number; dayKey: string }> {
    const dayKey = dayKeyIst(nowIst());

    const user = await this.userRepo.findById(input.userId);
    if (!user) throw new UnauthorizedError('User not found');
    if (user.blocked.isBlocked) {
      throw new ForbiddenError('USER_BLOCKED', 'Account is blocked');
    }
    if (user.coinBalance < VOTE_COST) {
      throw new PaymentRequiredError('INSUFFICIENT_COINS', `Need ${VOTE_COST} coins to vote`);
    }

    const session = await mongoose.startSession();
    try {
      const result = await session.withTransaction<{
        coinBalance: number;
        dayKey: string;
      }>(async () => {
        // Pattern 2 (CONVENTIONS.md "Transactions — pitfalls and patterns"):
        // terminal throw on duplicate. Transaction is intended to abort and
        // trigger VOTE_ALREADY_CAST. No continuation after this write.
        const voteData: Record<string, unknown> = {
          userId: input.userId,
          dayKey,
          target: input.target,
          coinsSpent: VOTE_COST,
          ipAddress: input.ipAddress,
        };
        if (input.deviceFingerprint) voteData['device'] = input.deviceFingerprint;

        const vote = await this.voteRepo.insertIfAbsent(voteData, { session });
        if (!vote) {
          throw new ConflictError('VOTE_ALREADY_CAST', 'Already voted today');
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

        return { coinBalance: updated.coinBalance, dayKey };
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
   * Today's vote status for the home feed's "vote" card. Returns
   * `canVote: false` if there's already a vote with today's dayKey,
   * `canVote: true` otherwise. `usedAt` is the vote's createdAt when
   * present.
   */
  async getTodayStatus(
    userId: Types.ObjectId,
  ): Promise<{ canVote: boolean; usedAt?: Date; dayKey: string }> {
    const dayKey = dayKeyIst(nowIst());
    const vote = await this.voteRepo.findByUserDay(userId, dayKey);
    if (vote) {
      return { canVote: false, usedAt: vote.createdAt, dayKey };
    }
    return { canVote: true, dayKey };
  }
}
