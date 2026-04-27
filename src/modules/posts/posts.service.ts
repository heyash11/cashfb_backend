import mongoose, { type Types } from 'mongoose';
import {
  ConflictError,
  ForbiddenError,
  InternalError,
  NotFoundError,
} from '../../shared/errors/AppError.js';
import type { CoinEventEmitter } from '../../shared/events/coinEvents.js';
import type { PostAdsConfig, PostAttrs } from '../../shared/models/Post.model.js';
import type { UserSubscriptionEntry } from '../../shared/models/User.model.js';
import { userCanAccessTier, type Tier } from '../../shared/models/_tier.js';
import { CoinTransactionRepository } from '../../shared/repositories/CoinTransaction.repository.js';
import { PostCompletionRepository } from '../../shared/repositories/PostCompletion.repository.js';
import { PostRepository } from '../../shared/repositories/Post.repository.js';
import { UserRepository } from '../../shared/repositories/User.repository.js';

export interface UserFacingPostDto {
  id: string;
  title: string;
  description?: string;
  dayKey: string;
  scheduledAt: Date;
  status: PostAttrs['status'];
  coinReward: number;
  tier: Tier;
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
  clock?: () => Date;
}

function toDto(post: PostAttrs, completed: boolean): UserFacingPostDto {
  const dto: UserFacingPostDto = {
    id: String(post._id),
    title: post.title,
    dayKey: post.dayKey,
    scheduledAt: post.scheduledAt,
    status: post.status,
    coinReward: post.coinReward,
    tier: post.tier,
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
  private readonly clock: () => Date;

  constructor(deps: PostServiceDeps) {
    this.coinEvents = deps.coinEvents;
    this.postRepo = deps.postRepo ?? new PostRepository();
    this.postCompletionRepo = deps.postCompletionRepo ?? new PostCompletionRepository();
    this.userRepo = deps.userRepo ?? new UserRepository();
    this.coinTxRepo = deps.coinTxRepo ?? new CoinTransactionRepository();
    this.clock = deps.clock ?? (() => new Date());
  }

  /**
   * Phase 11.4 — tier-scoped daily feed. The list endpoint contract:
   *
   *   - `tier` parameter is REQUIRED (controller-side Zod check).
   *   - Authorization: `userCanAccessTier(user.subscriptions, tier)` —
   *     STRICT. PRO_MAX-only user querying tier='PRO' → 403; their
   *     PRO_MAX subscription doesn't grant PRO access. Caller is
   *     expected to pre-check or handle the throw.
   *   - Filter: STRICT equality on `Post.tier`. PRO_MAX user querying
   *     tier='PRO_MAX' gets ONLY tier='PRO_MAX' posts (no PUBLIC
   *     inclusion). This is the parallel-section semantic flip from
   *     hierarchical gating.
   */
  async listForDate(
    dayKey: string,
    userId: Types.ObjectId,
    tier: Tier,
  ): Promise<UserFacingPostDto[]> {
    const posts = await this.postRepo.listForDayAndTier(dayKey, tier);
    const completions = await this.postCompletionRepo.find({ userId, dayKey });
    const completedIds = new Set(completions.map((c) => String(c.postId)));
    return posts.map((p) => toDto(p, completedIds.has(String(p._id))));
  }

  /**
   * Phase 11.4 — single-resource fetch. Per-resource auth is STRICT:
   * a PRO_MAX-only user with a deep link to a PRO post gets `null`
   * (caller surfaces 404). The list-scope and per-resource auth
   * agree: only your subscribed tiers are accessible, full stop.
   */
  async getById(
    postId: Types.ObjectId | string,
    userId: Types.ObjectId,
    subscriptions: ReadonlyArray<UserSubscriptionEntry>,
  ): Promise<UserFacingPostDto | null> {
    const post = await this.postRepo.findById(postId);
    if (!post) return null;
    if (!userCanAccessTier(subscriptions, post.tier, this.clock())) return null;
    const completion = await this.postCompletionRepo.findByUserPost(userId, post._id);
    return toDto(post, completion !== null);
  }

  /**
   * Atomic post completion. See docs/BUILD_PLAN.md §Phase 3 +
   * CONVENTIONS.md §Transactions — pitfalls and patterns.
   *
   * Phase 11.4 — auth uses `userCanAccessTier(subscriptions, ...)`.
   * STRICT semantics: only subscribed tiers are accessible.
   *
   * Pre-transaction (fast-reject, no writes):
   *   - NotFoundError if post absent.
   *   - ConflictError 'POST_NOT_LIVE' if status != LIVE.
   *   - ForbiddenError 'TIER_NOT_ACCESSIBLE' if user lacks the
   *     requested tier subscription.
   *
   * Transaction (pattern 1 per CONVENTIONS.md — upsert to keep the
   * session alive on the already-completed branch):
   *   1. Upsert post_completions with $setOnInsert (unique
   *      {userId, postId}). Null upsertedId → idempotent 200 with
   *      alreadyCompleted: true, no further writes.
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
    subscriptions: ReadonlyArray<UserSubscriptionEntry>;
  }): Promise<{ coinBalance: number; alreadyCompleted: boolean }> {
    const post = await this.postRepo.findById(input.postId);
    if (!post) throw new NotFoundError('Post not found');
    if (post.status !== 'LIVE') {
      throw new ConflictError('POST_NOT_LIVE', `Post is ${post.status}, cannot complete`);
    }
    if (!userCanAccessTier(input.subscriptions, post.tier, this.clock())) {
      throw new ForbiddenError(
        'TIER_NOT_ACCESSIBLE',
        `Subscription required to complete a ${post.tier} post`,
      );
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
