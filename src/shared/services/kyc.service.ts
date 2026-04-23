import type { Types } from 'mongoose';
import { PrizePoolWinnerModel } from '../models/PrizePoolWinner.model.js';
import type { UserAttrs, UserKyc } from '../models/User.model.js';
import { AppConfigRepository } from '../repositories/AppConfig.repository.js';
import { UserRepository } from '../repositories/User.repository.js';
import { currentFyBoundsIst } from '../utils/date.js';

export interface KycStatusResult {
  status: UserKyc['status'];
  panLast4?: string;
  verifiedAt?: Date;
}

export interface CumulativeFyPrizeResult {
  fyStart: Date;
  fyEnd: Date;
  totalPaise: number;
  winnerCount: number;
}

export interface KycGateDecision {
  /** true if the user may claim without further KYC action. */
  allowed: boolean;
  /** Present when `allowed: false` — machine-readable reason. */
  reason?: 'CUMULATIVE_FY_EXCEEDS_THRESHOLD_KYC_NOT_VERIFIED';
  /** Always included for observability + audit trail. */
  thresholdPaise: number;
  cumulativePaise: number;
  kycStatus: UserKyc['status'];
}

export interface KycServiceDeps {
  userRepo?: UserRepository;
  appConfigRepo?: AppConfigRepository;
  clock?: () => Date;
}

/**
 * Read-side KYC helpers: status, cumulative-FY prize value, and a
 * single-call gate evaluator. The prize-claim path invokes
 * `evaluateGate()` before running the atomic FCFS code flip — a
 * blocked decision throws `KycRequiredError(451)` upstream.
 *
 * Cumulative definition (per Phase 8 §8i): sum of `finalAmount`
 * across `PrizePoolWinner` rows in the current FY (Apr 1 → Mar 31
 * IST) where `payoutStatus ∈ {PENDING, RELEASED}`. WITHHELD and
 * VOID are excluded — they represent money the company does not
 * intend to pay out.
 */
export class KycService {
  private readonly userRepo: UserRepository;
  private readonly appConfigRepo: AppConfigRepository;
  private readonly clock: () => Date;

  constructor(deps: KycServiceDeps = {}) {
    this.userRepo = deps.userRepo ?? new UserRepository();
    this.appConfigRepo = deps.appConfigRepo ?? new AppConfigRepository();
    this.clock = deps.clock ?? (() => new Date());
  }

  async getKycStatus(userId: Types.ObjectId): Promise<KycStatusResult> {
    const user = await this.userRepo.findById(userId);
    if (!user) return { status: 'NONE' };
    return kycResultFromUser(user);
  }

  async cumulativeFyPrizeValue(
    userId: Types.ObjectId,
    now: Date = this.clock(),
  ): Promise<CumulativeFyPrizeResult> {
    const { start, end } = currentFyBoundsIst(now);
    const rows = await PrizePoolWinnerModel.find(
      {
        userId,
        payoutStatus: { $in: ['PENDING', 'RELEASED'] },
        createdAt: { $gte: start, $lte: end },
      },
      { finalAmount: 1 },
    ).lean<{ finalAmount?: number }[]>();

    let totalPaise = 0;
    for (const r of rows) totalPaise += r.finalAmount ?? 0;
    return { fyStart: start, fyEnd: end, totalPaise, winnerCount: rows.length };
  }

  /**
   * Single-call gate used by the claim path. Always returns a
   * decision — never throws. Callers translate `allowed: false`
   * into `KycRequiredError` themselves so the HTTP status (451)
   * and the error `details` payload stay centralised.
   */
  async evaluateGate(userId: Types.ObjectId, now: Date = this.clock()): Promise<KycGateDecision> {
    const [user, cfg, cumulative] = await Promise.all([
      this.userRepo.findById(userId),
      this.appConfigRepo.findOne({ key: 'default' }),
      this.cumulativeFyPrizeValue(userId, now),
    ]);
    const thresholdPaise = cfg?.kycThresholdAmount ?? 1_000_000;
    const kycStatus = user?.kyc?.status ?? 'NONE';

    const overThreshold = cumulative.totalPaise > thresholdPaise;
    const verified = kycStatus === 'VERIFIED';
    if (overThreshold && !verified) {
      return {
        allowed: false,
        reason: 'CUMULATIVE_FY_EXCEEDS_THRESHOLD_KYC_NOT_VERIFIED',
        thresholdPaise,
        cumulativePaise: cumulative.totalPaise,
        kycStatus,
      };
    }
    return {
      allowed: true,
      thresholdPaise,
      cumulativePaise: cumulative.totalPaise,
      kycStatus,
    };
  }
}

function kycResultFromUser(user: UserAttrs): KycStatusResult {
  const result: KycStatusResult = { status: user.kyc.status };
  if (user.kyc.panLast4 !== undefined) result.panLast4 = user.kyc.panLast4;
  if (user.kyc.verifiedAt !== undefined) result.verifiedAt = user.kyc.verifiedAt;
  return result;
}
