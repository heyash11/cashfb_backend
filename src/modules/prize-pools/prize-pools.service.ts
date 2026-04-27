import { logger } from '../../config/logger.js';
import { PrizePoolModel, type PrizePoolAttrs } from '../../shared/models/PrizePool.model.js';
import { VoteModel } from '../../shared/models/Vote.model.js';
import { AppConfigRepository } from '../../shared/repositories/AppConfig.repository.js';
import { PrizePoolRepository } from '../../shared/repositories/PrizePool.repository.js';

export interface ComputeAndPublishInput {
  /** The day the POOL is FOR (e.g. 2026-04-24 when summing votes from 2026-04-23). */
  dayKey: string;
  /** The day whose votes fund the pool. */
  yesterdayDayKey: string;
  clock?: () => Date;
}

export interface ComputeAndPublishResult {
  created: boolean;
  /** Raw count of vote rows (people-voted-yesterday metric). */
  yesterdayVoteCount: number;
  /** Tier-weighted sum: PUBLIC×1 + PRO×proMultiplier + PRO_MAX×proMaxMultiplier. */
  weightedVoteUnits: number;
  baseRatePaise: number;
  totalPoolPaise: number;
  giftCodeBudgetPaise: number;
  customRoomBudgetPaise: number;
  /** Per-tier raw vote breakdown that fed the weighted sum. */
  tierBreakdown: { public: number; pro: number; proMax: number };
}

export interface PrizePoolServiceDeps {
  prizePoolRepo?: PrizePoolRepository;
  appConfigRepo?: AppConfigRepository;
  clock?: () => Date;
}

const GIFT_CODE_SHARE = 0.7;

/**
 * Daily prize-pool computation. Intended to run as the Phase 7
 * midnight-IST BullMQ cron; callable directly for admin force-runs
 * or tests.
 *
 * Idempotency is the THIRD concrete example of CONVENTIONS.md
 * §Advisory pre-checks vs atomic predicates:
 *   - `PrizePool` has a unique index on `dayKey`
 *   - We use Pattern 1 (`updateOne + $setOnInsert + upsert, branch
 *     on upsertedId`) so two concurrent cron fires produce exactly
 *     one row; the loser returns `{created: false}` with the
 *     winner's values.
 *
 * Vote aggregation (`VoteModel.countDocuments({dayKey: yesterday})`)
 * runs OUTSIDE any transaction — the prior IST day's vote collection
 * is immutable once midnight has rolled over, so no lock needed.
 *
 * Budget split:
 *   giftCodeBudget  = floor(0.7 × total)
 *   customRoomBudget = total − giftCodeBudget
 * Odd-paisa residue absorbed into customRoomBudget (same pattern as
 * SGST in the GST splitter per invoicing/gst.ts).
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

    const [tierBuckets, cfg] = await Promise.all([
      this.aggregateVotesByTier(input.yesterdayDayKey),
      this.appConfigRepo.findOne({ key: 'default' }),
    ]);

    const baseRatePaise = cfg?.baseRatePerVote ?? 100;
    const proMultiplier = cfg?.proMultiplier ?? 5;
    const proMaxMultiplier = cfg?.proMaxMultiplier ?? 10;

    const tierBreakdown = { public: 0, pro: 0, proMax: 0 };
    for (const bucket of tierBuckets) {
      if (bucket._id === 'PRO') tierBreakdown.pro = bucket.count;
      else if (bucket._id === 'PRO_MAX') tierBreakdown.proMax = bucket.count;
      else tierBreakdown.public += bucket.count;
    }

    const yesterdayVoteCount = tierBreakdown.public + tierBreakdown.pro + tierBreakdown.proMax;
    const weightedVoteUnits =
      tierBreakdown.public +
      tierBreakdown.pro * proMultiplier +
      tierBreakdown.proMax * proMaxMultiplier;
    const totalPoolPaise = weightedVoteUnits * baseRatePaise;
    const giftCodeBudgetPaise = Math.floor(GIFT_CODE_SHARE * totalPoolPaise);
    const customRoomBudgetPaise = totalPoolPaise - giftCodeBudgetPaise;

    const seed: Partial<PrizePoolAttrs> = {
      dayKey: input.dayKey,
      yesterdayVoteCount,
      baseRate: baseRatePaise,
      totalPool: totalPoolPaise,
      giftCodeBudget: giftCodeBudgetPaise,
      customRoomBudget: customRoomBudgetPaise,
      proMultiplier,
      proMaxMultiplier,
      status: 'CALCULATED',
      calculatedAt: now,
    };

    // Pattern 1: atomic insert-or-inspect via $setOnInsert + upsert.
    // `new: false` + `rawResult/includeResultMetadata` give us
    // `updatedExisting` to distinguish insert-winner from redelivery.
    const upsert = await PrizePoolModel.findOneAndUpdate(
      { dayKey: input.dayKey },
      { $setOnInsert: seed },
      { upsert: true, new: false, rawResult: true, includeResultMetadata: true },
    );

    const updatedExisting = upsert?.lastErrorObject?.updatedExisting === true;

    if (!updatedExisting) {
      return {
        created: true,
        yesterdayVoteCount,
        weightedVoteUnits,
        baseRatePaise,
        totalPoolPaise,
        giftCodeBudgetPaise,
        customRoomBudgetPaise,
        tierBreakdown,
      };
    }

    // Row existed before our upsert. Return the pre-existing values
    // so callers get deterministic output on re-runs. `upsert.value`
    // is the pre-update doc.
    const prev = upsert.value as PrizePoolAttrs | null;
    if (!prev) {
      // Defensive — shouldn't happen when updatedExisting=true.
      logger.warn(
        { dayKey: input.dayKey },
        '[prize-pool] upsert reported existing but pre-doc was null; reporting computed values',
      );
      return {
        created: false,
        yesterdayVoteCount,
        weightedVoteUnits,
        baseRatePaise,
        totalPoolPaise,
        giftCodeBudgetPaise,
        customRoomBudgetPaise,
        tierBreakdown,
      };
    }

    // Re-derive weighted units from stored row so re-runs match the
    // winner exactly (multipliers may have been changed in AppConfig
    // between original compute and re-fire).
    const prevWeightedUnits =
      prev.totalPool > 0 && prev.baseRate > 0 ? prev.totalPool / prev.baseRate : 0;

    return {
      created: false,
      yesterdayVoteCount: prev.yesterdayVoteCount,
      weightedVoteUnits: prevWeightedUnits,
      baseRatePaise: prev.baseRate,
      totalPoolPaise: prev.totalPool,
      giftCodeBudgetPaise: prev.giftCodeBudget ?? 0,
      customRoomBudgetPaise: prev.customRoomBudget ?? 0,
      // Pre-existing rows don't store the per-tier breakdown;
      // re-runs return zeros to signal "not computed this run".
      tierBreakdown: { public: 0, pro: 0, proMax: 0 },
    };
  }

  /**
   * Tier-weighted vote aggregation (§PD5 fix, Phase 10.1). Joins each
   * vote to its caster's User row and groups by `tier`. Live-lookup
   * posture: a user who voted as PRO yesterday but downgraded to
   * PUBLIC before midnight compute is treated as PUBLIC. Acceptable
   * because the multiplier rewards SUBSCRIPTION STATE on settlement
   * day, and the tier-expiry sweep (Phase 6 Chunk 3) runs before this
   * cron at `5 0 * * *` IST.
   *
   * Missing-user fallback (`$ifNull → 'PUBLIC'`) covers two paths:
   *   - DPDP-anonymized voters whose User row was tombstoned
   *   - votes whose user was hard-deleted out of band
   * In both cases the vote still funds the pool at PUBLIC weight —
   * we don't penalize the rest of the day's voters by dropping rows.
   */
  private async aggregateVotesByTier(
    yesterdayDayKey: string,
  ): Promise<Array<{ _id: 'PUBLIC' | 'PRO' | 'PRO_MAX' | string; count: number }>> {
    return VoteModel.aggregate<{ _id: 'PUBLIC' | 'PRO' | 'PRO_MAX' | string; count: number }>([
      { $match: { dayKey: yesterdayDayKey } },
      {
        $lookup: {
          from: 'users',
          localField: 'userId',
          foreignField: '_id',
          as: 'voter',
          pipeline: [{ $project: { tier: 1 } }],
        },
      },
      {
        $addFields: {
          voterTier: {
            $ifNull: [{ $arrayElemAt: ['$voter.tier', 0] }, 'PUBLIC'],
          },
        },
      },
      {
        $group: {
          _id: '$voterTier',
          count: { $sum: 1 },
        },
      },
    ]);
  }
}
