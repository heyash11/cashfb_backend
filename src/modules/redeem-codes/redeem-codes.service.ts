import { type Types } from 'mongoose';
import { env } from '../../config/env.js';
import type { Encryptor } from '../../shared/encryption/envelope.js';
import { InMemoryEncryptor } from '../../shared/encryption/in-memory.js';
import { KmsEncryptor } from '../../shared/encryption/kms.js';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from '../../shared/errors/AppError.js';
import type { RedeemCodeAttrs } from '../../shared/models/RedeemCode.model.js';
import { PostCompletionRepository } from '../../shared/repositories/PostCompletion.repository.js';
import { RedeemCodeRepository } from '../../shared/repositories/RedeemCode.repository.js';
import { UserRepository } from '../../shared/repositories/User.repository.js';

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

export interface ClaimResult {
  codeId: Types.ObjectId;
  plaintextCode: string;
  denomination: number;
}

export interface RedeemCodeServiceDeps {
  redeemCodeRepo?: RedeemCodeRepository;
  postCompletionRepo?: PostCompletionRepository;
  userRepo?: UserRepository;
  encryptor?: Encryptor;
}

/**
 * User-facing redeem-code endpoints. Per CLAUDE.md §0.3 the FCFS
 * primitive is a single atomic `findOneAndUpdate` — no transactions,
 * no read-then-update. Tier gating is intentionally absent in MVP
 * (see plan §7c and OPEN_DECISIONS #1/#4); the `userTier` parameter
 * exists for forward compatibility with Phase 6 multiplier awards.
 */
export class RedeemCodeService {
  private readonly redeemCodeRepo: RedeemCodeRepository;
  private readonly postCompletionRepo: PostCompletionRepository;
  private readonly userRepo: UserRepository;
  private readonly encryptor: Encryptor;

  constructor(deps: RedeemCodeServiceDeps = {}) {
    this.redeemCodeRepo = deps.redeemCodeRepo ?? new RedeemCodeRepository();
    this.postCompletionRepo = deps.postCompletionRepo ?? new PostCompletionRepository();
    this.userRepo = deps.userRepo ?? new UserRepository();
    this.encryptor = deps.encryptor ?? defaultEncryptor();
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
   * FCFS claim. The atomic op is a single `findOneAndUpdate` with
   * `status: 'PUBLISHED'` as a predicate — exactly one concurrent
   * caller wins; every other sees `null` and surfaces `CODE_TAKEN`.
   *
   * Pre-checks (user-blocked, post-completed) run BEFORE the atomic
   * op, outside any transaction. They are advisory only: if the user
   * is blocked in the ~millisecond window between the check and the
   * op, they still get a code. Admin block workflows take
   * multi-second rotations (audit log write + UI refresh); this race
   * window is not user-reachable. The Phase 7 fraud sweep catches
   * any exotic drift at zero incremental complexity here. Do NOT
   * "fix" this with a two-phase CAS — it would buy nothing and add a
   * round trip.
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

    const claimed = await this.redeemCodeRepo.atomicFcfsClaim(codeId, userId);
    if (!claimed) {
      throw new ConflictError('CODE_TAKEN', 'This code has already been copied');
    }

    const plaintext = await this.encryptor.decryptField({
      ct: claimed.codeCt,
      iv: claimed.codeIv ?? '',
      tag: claimed.codeTag ?? '',
      dekEnc: claimed.codeDekEnc ?? '',
    });

    return {
      codeId: claimed._id,
      plaintextCode: plaintext,
      denomination: claimed.denomination,
    };
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
