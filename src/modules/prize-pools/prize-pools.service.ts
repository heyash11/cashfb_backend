import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone.js';
import utc from 'dayjs/plugin/utc.js';
import { logger } from '../../config/logger.js';
import { DonationModel } from '../../shared/models/Donation.model.js';
import { PrizePoolModel, type PrizePoolAttrs } from '../../shared/models/PrizePool.model.js';
import { VoteModel } from '../../shared/models/Vote.model.js';
import type { Tier } from '../../shared/models/_tier.js';
import { AppConfigRepository } from '../../shared/repositories/AppConfig.repository.js';
import { PrizePoolRepository } from '../../shared/repositories/PrizePool.repository.js';

dayjs.extend(utc);
dayjs.extend(timezone);

export interface ComputeAndPublishInput {
  /** The day the POOL is FOR (e.g. 2026-04-24 when summing votes from 2026-04-23). */
  dayKey: string;
  /** The day whose votes fund the pool. */
  yesterdayDayKey: string;
  /** Tier section this pool belongs to (Phase 11.2 — required). */
  tier: Tier;
  clock?: () => Date;
}

export interface ComputeAndPublishResult {
  created: boolean;
  tier: Tier;
  /** Raw count of votes cast in THIS tier on yesterdayDayKey. */
  voteCount: number;
  /** Multiplier actually applied: PUBLIC=1, PRO=cfg.proMultiplier, PRO_MAX=cfg.proMaxMultiplier. */
  tierMultiplier: number;
  baseRatePaise: number;
  /** voteCount × baseRate × tierMultiplier. */
  voteContributionPaise: number;
  /** Yesterday's CAPTURED donation sum — PUBLIC tier only; 0 for PRO/PRO_MAX. */
  donationContributionPaise: number;
  totalPoolPaise: number;
  giftCodeBudgetPaise: number;
  customRoomBudgetPaise: number;
}

export interface PrizePoolServiceDeps {
  prizePoolRepo?: PrizePoolRepository;
  appConfigRepo?: AppConfigRepository;
  clock?: () => Date;
}

const GIFT_CODE_SHARE = 0.7;
const IST_TIMEZONE = 'Asia/Kolkata';

/**
 * Daily prize-pool computation, per-tier (Phase 11.2). One call
 * produces one prize_pools row keyed by {tier, dayKey} unique
 * index from Phase 11.0. The cron handler fans out three calls
 * per fire (one per tier).
 *
 * Aggregation: a tier-pure `$match {dayKey, tier}` + `$count`.
 * The Phase 10.1 `$lookup users` join is gone — Phase 11.1's
 * snapshotted `Vote.tier` is the source of truth. No live user
 * lookup, no race window between vote time and pool compute.
 *
 * Donation funding (PRODUCT_MODEL.md §funding model):
 *   PUBLIC pool also adds yesterday's CAPTURED donation sum to
 *   `totalPool`. PRO and PRO_MAX pools skip this step (donations
 *   are platform-wide and don't carry tier scope).
 *
 * Idempotency: Pattern 1 upsert against {tier, dayKey}. Two
 * concurrent cron fires for the same (tier, dayKey) produce
 * exactly one row; the loser returns `{created: false}` with
 * the winner's stored values.
 *
 * Multipliers: read from AppConfig at compute time and stored on
 * the row (`proMultiplier`, `proMaxMultiplier` columns retained
 * from Phase 6/10.1). Historical pools remain auditable even if
 * AppConfig values change later.
 *
 * Budget split:
 *   giftCodeBudget   = floor(0.7 × total)
 *   customRoomBudget = total − giftCodeBudget
 * Odd-paisa residue absorbed into customRoomBudget.
 */
export class PrizePoolService {
  private readonly prizePoolRepo: PrizePoolRepository;
  private readonly appConfigRepo: AppConfigRepository;
  private readonly clock: () => Date;

  constructor(deps: PrizePoolServiceDeps = {}) {
    this.prizePoolRepo = deps.prizePoolRepo ?? new PrizePoolRepository();
    this.appConfigRepo = deps.appConfigRepo ?? new AppConfigRepository();
    this.clock = deps.clock ?? (() => new Date());
  }

  async computeAndPublishPool(input: ComputeAndPublishInput): Promise<ComputeAndPublishResult> {
    const now = (input.clock ?? this.clock)();

    const [voteCount, cfg, donationContributionPaise] = await Promise.all([
      VoteModel.countDocuments({ dayKey: input.yesterdayDayKey, tier: input.tier }),
      this.appConfigRepo.findOne({ key: 'default' }),
      input.tier === 'PUBLIC'
        ? this.aggregateCapturedDonationsForDay(input.yesterdayDayKey)
        : Promise.resolve(0),
    ]);

    const baseRatePaise = cfg?.baseRatePerVote ?? 100;
    const proMultiplier = cfg?.proMultiplier ?? 5;
    const proMaxMultiplier = cfg?.proMaxMultiplier ?? 10;
    const tierMultiplier =
      input.tier === 'PRO' ? proMultiplier : input.tier === 'PRO_MAX' ? proMaxMultiplier : 1;

    const voteContributionPaise = voteCount * baseRatePaise * tierMultiplier;
    const totalPoolPaise = voteContributionPaise + donationContributionPaise;
    const giftCodeBudgetPaise = Math.floor(GIFT_CODE_SHARE * totalPoolPaise);
    const customRoomBudgetPaise = totalPoolPaise - giftCodeBudgetPaise;

    const seed: Partial<PrizePoolAttrs> = {
      tier: input.tier,
      dayKey: input.dayKey,
      yesterdayVoteCount: voteCount,
      baseRate: baseRatePaise,
      totalPool: totalPoolPaise,
      giftCodeBudget: giftCodeBudgetPaise,
      customRoomBudget: customRoomBudgetPaise,
      proMultiplier,
      proMaxMultiplier,
      status: 'CALCULATED',
      calculatedAt: now,
    };

    // Pattern 1: atomic insert-or-inspect via $setOnInsert + upsert
    // against the {tier, dayKey} unique index. `new: false` +
    // `rawResult` give us `updatedExisting` to distinguish insert-
    // winner from redelivery.
    const upsert = await PrizePoolModel.findOneAndUpdate(
      { tier: input.tier, dayKey: input.dayKey },
      { $setOnInsert: seed },
      { upsert: true, new: false, rawResult: true, includeResultMetadata: true },
    );

    const updatedExisting = upsert?.lastErrorObject?.updatedExisting === true;

    if (!updatedExisting) {
      return {
        created: true,
        tier: input.tier,
        voteCount,
        tierMultiplier,
        baseRatePaise,
        voteContributionPaise,
        donationContributionPaise,
        totalPoolPaise,
        giftCodeBudgetPaise,
        customRoomBudgetPaise,
      };
    }

    // Row existed before our upsert. Return the pre-existing values
    // so callers get deterministic output on re-runs.
    const prev = upsert.value as PrizePoolAttrs | null;
    if (!prev) {
      logger.warn(
        { tier: input.tier, dayKey: input.dayKey },
        '[prize-pool] upsert reported existing but pre-doc was null; reporting computed values',
      );
      return {
        created: false,
        tier: input.tier,
        voteCount,
        tierMultiplier,
        baseRatePaise,
        voteContributionPaise,
        donationContributionPaise,
        totalPoolPaise,
        giftCodeBudgetPaise,
        customRoomBudgetPaise,
      };
    }

    // Re-derive tier-multiplier and contributions from the stored
    // row so re-runs surface the winner's values, not a fresh
    // re-compute (multipliers may have changed in AppConfig
    // between original compute and re-fire).
    const prevTierMul =
      prev.tier === 'PRO'
        ? prev.proMultiplier
        : prev.tier === 'PRO_MAX'
          ? prev.proMaxMultiplier
          : 1;
    const prevVoteContribution = prev.yesterdayVoteCount * prev.baseRate * prevTierMul;
    const prevDonationContribution = prev.totalPool - prevVoteContribution;

    return {
      created: false,
      tier: prev.tier,
      voteCount: prev.yesterdayVoteCount,
      tierMultiplier: prevTierMul,
      baseRatePaise: prev.baseRate,
      voteContributionPaise: prevVoteContribution,
      donationContributionPaise: prevDonationContribution,
      totalPoolPaise: prev.totalPool,
      giftCodeBudgetPaise: prev.giftCodeBudget ?? 0,
      customRoomBudgetPaise: prev.customRoomBudget ?? 0,
    };
  }

  /**
   * Phase 11.2 — sum CAPTURED donations whose `capturedAt` falls
   * within the IST-aligned window for `yesterdayDayKey`. Only
   * PUBLIC pool consumes this. Window:
   *   capturedAt ∈ [yesterdayDayKey 00:00 IST, today 00:00 IST)
   *
   * Strict bounds: a donation captured at IST 23:59 of yesterday
   * counts; one captured at IST 00:01 of today does NOT. The lower
   * bound is inclusive, upper bound exclusive. UTC drift cannot
   * leak donations from prior IST days into the window — this is
   * the off-by-one to watch.
   */
  private async aggregateCapturedDonationsForDay(yesterdayDayKey: string): Promise<number> {
    const startIst = dayjs.tz(yesterdayDayKey, IST_TIMEZONE).startOf('day').toDate();
    const endIst = dayjs.tz(yesterdayDayKey, IST_TIMEZONE).add(1, 'day').startOf('day').toDate();

    const result = await DonationModel.aggregate<{ _id: null; total: number }>([
      {
        $match: {
          status: 'CAPTURED',
          capturedAt: { $gte: startIst, $lt: endIst },
        },
      },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]);

    return result[0]?.total ?? 0;
  }
}
