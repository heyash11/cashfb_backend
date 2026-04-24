import type { Types } from 'mongoose';
import { BadRequestError, NotFoundError, UnauthorizedError } from '../../shared/errors/AppError.js';
import { LoginSessionRepository } from '../../shared/repositories/LoginSession.repository.js';
import { UserRepository } from '../../shared/repositories/User.repository.js';
import { ForceLogoutStore } from '../../shared/services/force-logout.js';

/**
 * DPDP erasure state machine (Phase 9 Chunk 4 — see docs/DPDP.md §3).
 *
 *   normal ─[ POST /me/account/erasure ]──▶ requested (deletedAt set)
 *   requested ─[ DELETE /me/account/erasure ]──▶ normal (deletedAt unset, denylist cleared)
 *   requested ─[ POST /admin/users/:id/erasure-hold ]──▶ on-hold
 *   on-hold ─[ DELETE /admin/users/:id/erasure-hold ]──▶ requested (deletedAt advanced forward by held duration)
 *   requested + 30d elapsed ─[ sweep worker ]──▶ anonymized (terminal)
 *
 * Request side-effects beyond setting deletedAt:
 *   - revoke every active LoginSession for the user (no new refreshes possible)
 *   - write a force-logout Redis cutoff (invalidates any still-valid 15-min access token)
 *
 * Cancel side-effects:
 *   - unset deletedAt
 *   - DELETE the force-logout Redis key so the user can resume with
 *     fresh OTP login (letting it TTL-expire would lock them out
 *     for up to 30 days, which is bad UX for a cancelled erasure)
 */

export interface ErasureStatus {
  requested: boolean;
  deletedAt?: Date;
  anonymizedAt?: Date;
  held: boolean;
  /** Integer days until auto-anonymization. Only set when requested && !held && !anonymizedAt. */
  daysRemaining?: number;
  gracePeriodDays: 30;
}

export const GRACE_PERIOD_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface UserErasureServiceDeps {
  userRepo?: UserRepository;
  sessionRepo?: LoginSessionRepository;
  forceLogoutStore?: ForceLogoutStore;
  clock?: () => Date;
}

export class UserErasureService {
  private readonly userRepo: UserRepository;
  private readonly sessionRepo: LoginSessionRepository;
  private readonly forceLogoutStore: ForceLogoutStore;
  private readonly clock: () => Date;

  constructor(deps: UserErasureServiceDeps = {}) {
    this.userRepo = deps.userRepo ?? new UserRepository();
    this.sessionRepo = deps.sessionRepo ?? new LoginSessionRepository();
    this.forceLogoutStore = deps.forceLogoutStore ?? new ForceLogoutStore();
    this.clock = deps.clock ?? (() => new Date());
  }

  async request(userId: Types.ObjectId): Promise<ErasureStatus> {
    const user = await this.userRepo.findById(userId);
    if (!user) throw new UnauthorizedError('User not found');
    if (user.anonymizedAt) {
      // Should be unreachable — anonymized users can't produce a
      // valid bearer token — but defensive.
      throw new BadRequestError('ALREADY_ANONYMIZED', 'Account has already been anonymized');
    }

    // Idempotent: re-requesting during grace is a no-op; deletedAt
    // does not move. Returning the current status is the right UX
    // (the client can just re-render the status screen).
    if (user.deletedAt) {
      return this.toStatus(user.deletedAt, user.erasureHold?.active === true, user.anonymizedAt);
    }

    const now = this.clock();
    await this.userRepo.findOneAndUpdate({ _id: userId }, { $set: { deletedAt: now } });
    await this.sessionRepo.revokeAllForUser(userId);
    await this.forceLogoutStore.forceLogout(userId.toHexString());

    return this.toStatus(now, false, undefined);
  }

  async cancel(userId: Types.ObjectId): Promise<ErasureStatus> {
    const user = await this.userRepo.findById(userId);
    if (!user) throw new UnauthorizedError('User not found');
    if (user.anonymizedAt) {
      throw new BadRequestError(
        'ALREADY_ANONYMIZED',
        'Cannot cancel — account has already been anonymized',
      );
    }
    if (!user.deletedAt) {
      throw new NotFoundError('No erasure request pending');
    }

    await this.userRepo.findOneAndUpdate(
      { _id: userId },
      { $unset: { deletedAt: '', erasureHold: '' } },
    );
    // DELETE the force-logout key so the user can resume with a
    // fresh OTP login. Letting the 30-day TTL run out would lock
    // them out with no recourse after a cancelled erasure.
    await this.forceLogoutStore.clear(userId.toHexString());

    return { requested: false, held: false, gracePeriodDays: GRACE_PERIOD_DAYS };
  }

  async status(userId: Types.ObjectId): Promise<ErasureStatus> {
    const user = await this.userRepo.findById(userId);
    if (!user) throw new UnauthorizedError('User not found');
    return this.toStatus(user.deletedAt, user.erasureHold?.active === true, user.anonymizedAt);
  }

  private toStatus(deletedAt?: Date, held = false, anonymizedAt?: Date): ErasureStatus {
    if (anonymizedAt) {
      return {
        requested: true,
        anonymizedAt,
        ...(deletedAt ? { deletedAt } : {}),
        held,
        gracePeriodDays: GRACE_PERIOD_DAYS,
      };
    }
    if (!deletedAt) {
      return { requested: false, held: false, gracePeriodDays: GRACE_PERIOD_DAYS };
    }
    const base: ErasureStatus = {
      requested: true,
      deletedAt,
      held,
      gracePeriodDays: GRACE_PERIOD_DAYS,
    };
    if (!held) {
      const elapsedMs = this.clock().getTime() - deletedAt.getTime();
      const remaining = Math.max(
        0,
        Math.ceil((GRACE_PERIOD_DAYS * MS_PER_DAY - elapsedMs) / MS_PER_DAY),
      );
      base.daysRemaining = remaining;
    }
    return base;
  }
}

/** Conflict codes surfaced to admin callers when the hold transition is invalid. */
export const ERASURE_CONFLICT = {
  NO_PENDING_ERASURE: 'NO_PENDING_ERASURE',
  ALREADY_HELD: 'ALREADY_HELD',
  NOT_HELD: 'NOT_HELD',
} as const;

export type ErasureConflictCode = (typeof ERASURE_CONFLICT)[keyof typeof ERASURE_CONFLICT];
