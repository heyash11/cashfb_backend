import type Redis from 'ioredis';
import { redis as defaultRedis } from '../../config/redis.js';
import { DonationModel } from '../../shared/models/Donation.model.js';
import { PostModel } from '../../shared/models/Post.model.js';
import { PrizePoolWinnerModel } from '../../shared/models/PrizePoolWinner.model.js';
import { SubscriptionModel } from '../../shared/models/Subscription.model.js';
import { UserModel } from '../../shared/models/User.model.js';
import { VoteModel } from '../../shared/models/Vote.model.js';
import { dayKeyIst } from '../../shared/utils/date.js';

export interface DashboardMetrics {
  users: {
    total: number;
    blocked: number;
  };
  today: {
    dayKey: string;
    posts: number;
    votes: number;
    donationsCount: number;
    donationsTotalPaise: number;
  };
  subscriptions: {
    activeTotal: number;
    activePro: number;
    activeProMax: number;
  };
  payouts: {
    pending: number;
    released: number;
  };
}

export interface DashboardResponse {
  data: DashboardMetrics;
  generatedAt: string; // ISO timestamp
  cached: boolean;
}

export interface AdminDashboardServiceDeps {
  redis?: Redis;
  clock?: () => Date;
  ttlSeconds?: number;
}

const CACHE_KEY = 'admin:dashboard:metrics';
const DEFAULT_TTL_SECONDS = 60;

/**
 * Redis-cached dashboard metrics. Cache shape is the whole
 * {data, generatedAt} envelope serialised as JSON; TTL 60s per the
 * Phase 8 Chunk 3a sign-off. No active invalidation — operators
 * accept up to 60s staleness on the dashboard. The `generatedAt`
 * field is surfaced in the HTTP response so the UI can show
 * "Data as of 2:47 PM."
 *
 * The actual aggregation runs 6 countDocuments + 1 small aggregate
 * in parallel. Cheap enough that we don't add individual metric
 * caches; the full roll-up sits behind one key.
 */
export class AdminDashboardService {
  private readonly redis: Redis;
  private readonly clock: () => Date;
  private readonly ttlSeconds: number;

  constructor(deps: AdminDashboardServiceDeps = {}) {
    this.redis = deps.redis ?? defaultRedis;
    this.clock = deps.clock ?? (() => new Date());
    this.ttlSeconds = deps.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  }

  async getMetrics(): Promise<DashboardResponse> {
    const cached = await this.redis.get(CACHE_KEY);
    if (cached) {
      const parsed = JSON.parse(cached) as { data: DashboardMetrics; generatedAt: string };
      return { data: parsed.data, generatedAt: parsed.generatedAt, cached: true };
    }

    const now = this.clock();
    const dayKey = dayKeyIst(now);

    const [
      totalUsers,
      blockedUsers,
      todayPosts,
      todayVotes,
      donationsTodayAgg,
      activePro,
      activeProMax,
      pendingPayouts,
      releasedPayouts,
    ] = await Promise.all([
      UserModel.countDocuments({}),
      UserModel.countDocuments({ 'blocked.isBlocked': true }),
      PostModel.countDocuments({ dayKey }),
      VoteModel.countDocuments({ dayKey }),
      DonationModel.aggregate<{ count: number; total: number }>([
        {
          $match: {
            status: 'CAPTURED',
            createdAt: { $gte: startOfIstDay(now), $lt: endOfIstDay(now) },
          },
        },
        { $group: { _id: null, count: { $sum: 1 }, total: { $sum: '$amount' } } },
      ]),
      SubscriptionModel.countDocuments({ status: 'ACTIVE', tier: 'PRO' }),
      SubscriptionModel.countDocuments({ status: 'ACTIVE', tier: 'PRO_MAX' }),
      PrizePoolWinnerModel.countDocuments({ payoutStatus: 'PENDING' }),
      PrizePoolWinnerModel.countDocuments({ payoutStatus: 'RELEASED' }),
    ]);

    const donationsAgg = donationsTodayAgg[0] ?? { count: 0, total: 0 };

    const data: DashboardMetrics = {
      users: {
        total: totalUsers,
        blocked: blockedUsers,
      },
      today: {
        dayKey,
        posts: todayPosts,
        votes: todayVotes,
        donationsCount: donationsAgg.count,
        donationsTotalPaise: donationsAgg.total,
      },
      subscriptions: {
        activeTotal: activePro + activeProMax,
        activePro,
        activeProMax,
      },
      payouts: {
        pending: pendingPayouts,
        released: releasedPayouts,
      },
    };

    const generatedAt = now.toISOString();
    await this.redis.set(CACHE_KEY, JSON.stringify({ data, generatedAt }), 'EX', this.ttlSeconds);
    return { data, generatedAt, cached: false };
  }

  /** Visible for tests that want to verify the cache path without sleeping. */
  async clearCache(): Promise<void> {
    await this.redis.del(CACHE_KEY);
  }
}

function startOfIstDay(d: Date): Date {
  // IST is UTC+5:30. Convert to IST, zero the time-of-day, convert back.
  const ist = new Date(d.getTime() + 5.5 * 60 * 60_000);
  ist.setUTCHours(0, 0, 0, 0);
  return new Date(ist.getTime() - 5.5 * 60 * 60_000);
}

function endOfIstDay(d: Date): Date {
  const start = startOfIstDay(d);
  return new Date(start.getTime() + 24 * 60 * 60_000);
}
