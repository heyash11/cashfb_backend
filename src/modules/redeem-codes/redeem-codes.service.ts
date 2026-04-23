import mongoose, { type Types } from 'mongoose';
import { env } from '../../config/env.js';
import type { Encryptor } from '../../shared/encryption/envelope.js';
import { InMemoryEncryptor } from '../../shared/encryption/in-memory.js';
import { KmsEncryptor } from '../../shared/encryption/kms.js';
import {
  ConflictError,
  ForbiddenError,
  KycRequiredError,
  NotFoundError,
  UnauthorizedError,
} from '../../shared/errors/AppError.js';
import { PrizePoolWinnerModel } from '../../shared/models/PrizePoolWinner.model.js';
import type { RedeemCodeAttrs } from '../../shared/models/RedeemCode.model.js';
import { PostCompletionRepository } from '../../shared/repositories/PostCompletion.repository.js';
import { RedeemCodeRepository } from '../../shared/repositories/RedeemCode.repository.js';
import { UserRepository } from '../../shared/repositories/User.repository.js';
import { KycService } from '../../shared/services/kyc.service.js';
import { computeTds194BA } from '../../shared/services/tds.js';

export interface ListForPostInput {
  postId: Types.ObjectId;
  userId: Types.ObjectId;
  userTier: 'PUBLIC' | 'PRO' | 'PRO_MAX';
}

export interface ListForPostItem {
  _id: Types.ObjectId;
  denomination: number;
  status: 'PUBLISHED' | 'COPIED' | 'CLAIMED' | 'EXPIRED' | 'VOID';
}

/**
 * TDS side-effect shape returned alongside a successful claim.
 * `null` is an explicit "evaluated, not applicable" signal — the
 * claim succeeded but no linked PrizePoolWinner row was found for
 * (userId, redeemCodeId), so there was nothing to deduct TDS on.
 * Chunk 4 sign-off §R2: explicit null beats omitted field.
 */
export interface ClaimTdsResult {
  deductedPaise: number;
  appliedOn: 'PrizePoolWinner';
  winnerId: Types.ObjectId;
}

export interface ClaimResult {
  codeId: Types.ObjectId;
  plaintextCode: string;
  denomination: number;
  tds: ClaimTdsResult | null;
}

export interface RedeemCodeServiceDeps {
  redeemCodeRepo?: RedeemCodeRepository;
  postCompletionRepo?: PostCompletionRepository;
  userRepo?: UserRepository;
  encryptor?: Encryptor;
  kycService?: KycService;
  clock?: () => Date;
}

/**
 * User-facing redeem-code endpoints. Per CLAUDE.md §0.3 the FCFS
 * primitive is a single atomic `findOneAndUpdate` — the winner is
 * decided by the mongo predicate. Phase 8 Chunk 4 adds a KYC+TDS
 * gate in front of the atomic op and a transactional
 * PrizePoolWinner flip behind it (see `claim()` for detail).
 */
export class RedeemCodeService {
  private readonly redeemCodeRepo: RedeemCodeRepository;
  private readonly postCompletionRepo: PostCompletionRepository;
  private readonly userRepo: UserRepository;
  private readonly encryptor: Encryptor;
  private readonly kycService: KycService;
  private readonly clock: () => Date;

  constructor(deps: RedeemCodeServiceDeps = {}) {
    this.redeemCodeRepo = deps.redeemCodeRepo ?? new RedeemCodeRepository();
    this.postCompletionRepo = deps.postCompletionRepo ?? new PostCompletionRepository();
    this.userRepo = deps.userRepo ?? new UserRepository();
    this.encryptor = deps.encryptor ?? defaultEncryptor();
    this.kycService = deps.kycService ?? new KycService();
    this.clock = deps.clock ?? (() => new Date());
  }

  /**
   * Return the redeem codes attached to a post as status-only rows.
   * Plaintext is NEVER included here — the client has to hit `claim`
   * to see the actual code. Requires the caller to have completed
   * the post.
   */
  async listForPost(input: ListForPostInput): Promise<ListForPostItem[]> {
    const completion = await this.postCompletionRepo.findByUserPost(input.userId, input.postId);
    if (!completion) {
      throw new ForbiddenError('POST_NOT_COMPLETED', 'Complete the post to view its codes');
    }

    const codes = await this.redeemCodeRepo.find(
      { postId: input.postId, status: { $ne: 'AVAILABLE' } },
      { sort: { createdAt: 1, _id: 1 } },
    );

    return codes.map((c) => ({
      _id: c._id,
      denomination: c.denomination,
      status: c.status as ListForPostItem['status'],
    }));
  }

  /**
   * FCFS claim with the Phase 8 KYC gate + transactional
   * PrizePoolWinner settlement.
   *
   * Flow:
   *   1. Advisory pre-checks (user block, post completion).
   *   2. KYC gate via `KycService.evaluateGate` — throws
   *      `KycRequiredError(451)` when cumulative FY winnings exceed
   *      `AppConfig.kycThresholdAmount` AND `user.kyc.status !==
   *      'VERIFIED'`.
   *   3. Transaction:
   *        a. Atomic FCFS flip (PUBLISHED → COPIED).
   *        b. If a matching `PrizePoolWinner` row exists for
   *           `(userId, redeemCodeId)`, compute TDS via §194BA,
   *           set `payoutStatus: RELEASED`, write `tdsDeducted`,
   *           `releasedAt`, and `panAtPayout` from the user's
   *           stored panLast4 (if any).
   *        c. No linked winner row → no-op on that side; `tds`
   *           field in the response is `null` (explicit signal).
   *
   * Pre-checks stay advisory (outside the transaction) to avoid a
   * round-trip in the happy path; the atomic predicate is still the
   * final guarantee for FCFS correctness. See the Phase 3 commit
   * message for the original reasoning.
   */
  async claim(codeId: Types.ObjectId, userId: Types.ObjectId): Promise<ClaimResult> {
    const code = await this.redeemCodeRepo.findById(codeId);
    if (!code || !code.postId) {
      throw new NotFoundError('Redeem code not found');
    }

    const user = await this.userRepo.findById(userId);
    if (!user) {
      throw new UnauthorizedError('User not found');
    }
    if (user.blocked.isBlocked) {
      throw new UnauthorizedError('User is blocked');
    }

    const completion = await this.postCompletionRepo.findByUserPost(userId, code.postId);
    if (!completion) {
      throw new ForbiddenError('POST_NOT_COMPLETED', 'Complete the post before claiming');
    }

    const gate = await this.kycService.evaluateGate(userId, this.clock());
    if (!gate.allowed) {
      throw new KycRequiredError('PAN required to claim this prize', {
        thresholdPaise: gate.thresholdPaise,
        cumulativePaise: gate.cumulativePaise,
        kycStatus: gate.kycStatus,
      });
    }

    const session = await mongoose.startSession();
    try {
      let claimed: RedeemCodeAttrs | null = null;
      let tds: ClaimTdsResult | null = null;

      await session.withTransaction(async () => {
        claimed = await this.redeemCodeRepo.atomicFcfsClaim(codeId, userId, { session });
        if (!claimed) return;

        // Match the PrizePoolWinner row written by the daily-pool
        // cron (or admin assignWinners). Either indexing on
        // redeemCodeId OR on (userId, type: GIFT_CODE) would work;
        // redeemCodeId is the authoritative linkage when present.
        const winner = await PrizePoolWinnerModel.findOneAndUpdate(
          {
            userId,
            redeemCodeId: codeId,
            payoutStatus: 'PENDING',
          },
          {
            $set: {
              payoutStatus: 'RELEASED',
              releasedAt: this.clock(),
              ...(user.kyc.panLast4 ? { panAtPayout: `XXXXX${user.kyc.panLast4}` } : {}),
            },
          },
          { session, new: true },
        );
        if (winner && typeof winner.finalAmount === 'number') {
          const deductedPaise = computeTds194BA(winner.finalAmount);
          await PrizePoolWinnerModel.updateOne(
            { _id: winner._id },
            { $set: { tdsDeducted: deductedPaise } },
            { session },
          );
          tds = { deductedPaise, appliedOn: 'PrizePoolWinner', winnerId: winner._id };
        }
      });

      if (!claimed) {
        throw new ConflictError('CODE_TAKEN', 'This code has already been copied');
      }

      const plaintext = await this.encryptor.decryptField({
        ct: (claimed as RedeemCodeAttrs).codeCt,
        iv: (claimed as RedeemCodeAttrs).codeIv ?? '',
        tag: (claimed as RedeemCodeAttrs).codeTag ?? '',
        dekEnc: (claimed as RedeemCodeAttrs).codeDekEnc ?? '',
      });

      return {
        codeId: (claimed as RedeemCodeAttrs)._id,
        plaintextCode: plaintext,
        denomination: (claimed as RedeemCodeAttrs).denomination,
        tds,
      };
    } finally {
      await session.endSession();
    }
  }

  /**
   * User self-declaration that they redeemed the code on Google
   * Play. Partner state transition to `claim()`: COPIED → CLAIMED.
   * The predicate `{status: 'COPIED', firstCopiedBy: userId}`
   * guarantees only the copier can flip it.
   */
  async markClaimed(codeId: Types.ObjectId, userId: Types.ObjectId): Promise<void> {
    const updated = await this.redeemCodeRepo.findOneAndUpdate(
      { _id: codeId, status: 'COPIED', firstCopiedBy: userId },
      { $set: { status: 'CLAIMED', claimedBy: userId, claimedAt: new Date() } },
    );
    if (!updated) {
      throw new ConflictError('CODE_NOT_OWNED', 'This code is not yours to mark as claimed');
    }
  }

  /** Exposed for controller DTO mapping. */
  static toListItem(c: RedeemCodeAttrs): ListForPostItem {
    return {
      _id: c._id,
      denomination: c.denomination,
      status: c.status as ListForPostItem['status'],
    };
  }
}

function defaultEncryptor(): Encryptor {
  if (env.KMS_KEY_ID && env.AWS_REGION) {
    return new KmsEncryptor({ region: env.AWS_REGION, keyId: env.KMS_KEY_ID });
  }
  return new InMemoryEncryptor();
}
