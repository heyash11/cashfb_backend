import mongoose, { type Types } from 'mongoose';
import {
  ConflictError,
  ForbiddenError,
  InternalError,
  NotFoundError,
} from '../../shared/errors/AppError.js';
import type { CoinEventEmitter } from '../../shared/events/coinEvents.js';
import type { PostAdsConfig, PostAttrs } from '../../shared/models/Post.model.js';
import { CoinTransactionRepository } from '../../shared/repositories/CoinTransaction.repository.js';
import { PostCompletionRepository } from '../../shared/repositories/PostCompletion.repository.js';
import { PostRepository } from '../../shared/repositories/Post.repository.js';
import { UserRepository } from '../../shared/repositories/User.repository.js';

type Tier = 'PUBLIC' | 'PRO' | 'PRO_MAX';

export interface UserFacingPostDto {
  id: string;
  title: string;
  description?: string;
  dayKey: string;
  scheduledAt: Date;
  status: PostAttrs['status'];
  coinReward: number;
  tierRequired: Tier;
  adsConfig?: PostAdsConfig;
  publishedAt?: Date;
  closedAt?: Date;
  completed: boolean;
}

export interface PostServiceDeps {
  coinEvents: CoinEventEmitter;
  postRepo?: PostRepository;
  postCompletionRepo?: PostCompletionRepository;
  userRepo?: UserRepository;
  coinTxRepo?: CoinTransactionRepository;
}

function tierAllowsAccess(userTier: Tier, required: Tier): boolean {
  if (required === 'PUBLIC') return true;
  if (required === 'PRO') return userTier === 'PRO' || userTier === 'PRO_MAX';
  return userTier === 'PRO_MAX';
}

function toDto(post: PostAttrs, completed: boolean): UserFacingPostDto {
  const dto: UserFacingPostDto = {
    id: String(post._id),
    title: post.title,
    dayKey: post.dayKey,
    scheduledAt: post.scheduledAt,
    status: post.status,
    coinReward: post.coinReward,
    tierRequired: post.tierRequired,
    completed,
  };
  if (post.description) dto.description = post.description;
  if (post.adsConfig) dto.adsConfig = post.adsConfig;
  if (post.publishedAt) dto.publishedAt = post.publishedAt;
  if (post.closedAt) dto.closedAt = post.closedAt;
  return dto;
}

export class PostService {
  private readonly coinEvents: CoinEventEmitter;
  private readonly postRepo: PostRepository;
  private readonly postCompletionRepo: PostCompletionRepository;
  private readonly userRepo: UserRepository;
  private readonly coinTxRepo: CoinTransactionRepository;

  constructor(deps: PostServiceDeps) {
    this.coinEvents = deps.coinEvents;
    this.postRepo = deps.postRepo ?? new PostRepository();
    this.postCompletionRepo = deps.postCompletionRepo ?? new PostCompletionRepository();
    this.userRepo = deps.userRepo ?? new UserRepository();
    this.coinTxRepo = deps.coinTxRepo ?? new CoinTransactionRepository();
  }

  async listForDate(
    dayKey: string,
    userId: Types.ObjectId,
    userTier: Tier,
  ): Promise<UserFacingPostDto[]> {
    const posts = await this.postRepo.listForDay(dayKey);
    const completions = await this.postCompletionRepo.find({ userId, dayKey });
    const completedIds = new Set(completions.map((c) => String(c.postId)));
    return posts
      .filter((p) => tierAllowsAccess(userTier, p.tierRequired))
      .map((p) => toDto(p, completedIds.has(String(p._id))));
  }

  async getById(
    postId: Types.ObjectId | string,
    userId: Types.ObjectId,
    userTier: Tier,
  ): Promise<UserFacingPostDto | null> {
    const post = await this.postRepo.findById(postId);
    if (!post) return null;
    if (!tierAllowsAccess(userTier, post.tierRequired)) return null;
    const completion = await this.postCompletionRepo.findByUserPost(userId, post._id);
    return toDto(post, completion !== null);
  }

  /**
   * Atomic post completion. See docs/BUILD_PLAN.md §Phase 3 +
   * CONVENTIONS.md §Transactions and punitive writes.
   *
   * Pre-transaction (fast-reject, no writes):
   *   - NotFoundError if post absent.
   *   - ConflictError 'POST_NOT_LIVE' if status != LIVE.
   *   - ForbiddenError 'TIER_REQUIRED' if user tier insufficient.
   *
   * Transaction:
   *   1. Insert post_completions via `insertIfAbsent`
   *      (unique {userId, postId}). Null on duplicate → idempotent
   *      200 with alreadyCompleted: true, no further writes.
   *   2. $inc users.coinBalance by post.coinReward.
   *   3. Insert coin_transactions POST_REWARD with balanceAfter.
   *   4. Back-link completion.coinTxId.
   *
   * Post-transaction:
   *   - Emit coins.updated only when a coin was actually awarded.
   */
  async completePost(input: {
    postId: Types.ObjectId;
    userId: Types.ObjectId;
    userTier: Tier;
  }): Promise<{ coinBalance: number; alreadyCompleted: boolean }> {
    const post = await this.postRepo.findById(input.postId);
    if (!post) throw new NotFoundError('Post not found');
    if (post.status !== 'LIVE') {
      throw new ConflictError('POST_NOT_LIVE', `Post is ${post.status}, cannot complete`);
    }
    if (!tierAllowsAccess(input.userTier, post.tierRequired)) {
      throw new ForbiddenError('TIER_REQUIRED', `Post requires tier ${post.tierRequired}`);
    }

    const { dayKey, coinReward } = post;

    const session = await mongoose.startSession();
    try {
      // Use `updateOne` with `upsert: true` rather than a raw
      // `insertIfAbsent`. A plain insert that fails on the unique
      // {userId, postId} index would abort the Mongo transaction,
      // after which every subsequent read in the same callback
      // fails with NoSuchTransaction and withTransaction retries
      // forever. Upsert keeps the transaction alive on the
      // already-completed path: it matches the existing doc
      // (upsertedId is null) and we branch on that.
      //
      // Returning the result from withTransaction (rather than
      // mutating a closed-over let) also sidesteps TS closure-
      // mutation narrowing issues. See CONVENTIONS.md §Transactions
      // and punitive writes.
      const result = await session.withTransaction<{
        coinBalance: number;
        alreadyCompleted: boolean;
      }>(async () => {
        const upsert = await this.postCompletionRepo.updateOne(
          { userId: input.userId, postId: input.postId },
          {
            $setOnInsert: {
              userId: input.userId,
              postId: input.postId,
              dayKey,
              completedAt: new Date(),
              coinAwarded: coinReward,
            },
          },
          { upsert: true, session },
        );

        if (!upsert.upsertedId) {
          // Already completed. Read current balance and return.
          const user = await this.userRepo.findById(input.userId);
          if (!user) {
            throw new InternalError('INVARIANT', 'user missing during completion lookup');
          }
          return { coinBalance: user.coinBalance, alreadyCompleted: true };
        }

        const updated = await this.userRepo.incCoinBalance(input.userId, coinReward, session);
        if (!updated) {
          throw new InternalError('INVARIANT', 'user missing during coin award');
        }

        const coinTx = await this.coinTxRepo.create(
          {
            userId: input.userId,
            type: 'POST_REWARD',
            amount: coinReward,
            balanceAfter: updated.coinBalance,
            reference: { kind: 'Post', id: input.postId },
          },
          { session },
        );

        await this.postCompletionRepo.updateOne(
          { _id: upsert.upsertedId },
          { $set: { coinTxId: coinTx._id } },
          { session },
        );

        return { coinBalance: updated.coinBalance, alreadyCompleted: false };
      });

      if (!result) {
        throw new InternalError('COMPLETE_FAILED', 'transaction produced no result');
      }

      if (!result.alreadyCompleted) {
        await this.coinEvents.emitCoinsUpdated({
          userId: input.userId,
          coinBalance: result.coinBalance,
          reason: 'POST_REWARD',
        });
      }

      return result;
    } finally {
      await session.endSession();
    }
  }
}
