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
  yesterdayVoteCount: number;
  baseRatePaise: number;
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

    const [voteCount, cfg] = await Promise.all([
      VoteModel.countDocuments({ dayKey: input.yesterdayDayKey }),
      this.appConfigRepo.findOne({ key: 'default' }),
    ]);

    const baseRatePaise = cfg?.baseRatePerVote ?? 100;
    const totalPoolPaise = voteCount * baseRatePaise;
    const giftCodeBudgetPaise = Math.floor(GIFT_CODE_SHARE * totalPoolPaise);
    const customRoomBudgetPaise = totalPoolPaise - giftCodeBudgetPaise;

    const seed: Partial<PrizePoolAttrs> = {
      dayKey: input.dayKey,
      yesterdayVoteCount: voteCount,
      baseRate: baseRatePaise,
      totalPool: totalPoolPaise,
      giftCodeBudget: giftCodeBudgetPaise,
      customRoomBudget: customRoomBudgetPaise,
      proMultiplier: cfg?.proMultiplier ?? 5,
      proMaxMultiplier: cfg?.proMaxMultiplier ?? 10,
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
        yesterdayVoteCount: voteCount,
        baseRatePaise,
        totalPoolPaise,
        giftCodeBudgetPaise,
        customRoomBudgetPaise,
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
        yesterdayVoteCount: voteCount,
        baseRatePaise,
        totalPoolPaise,
        giftCodeBudgetPaise,
        customRoomBudgetPaise,
      };
    }

    return {
      created: false,
      yesterdayVoteCount: prev.yesterdayVoteCount,
      baseRatePaise: prev.baseRate,
      totalPoolPaise: prev.totalPool,
      giftCodeBudgetPaise: prev.giftCodeBudget ?? 0,
      customRoomBudgetPaise: prev.customRoomBudget ?? 0,
    };
  }
}
