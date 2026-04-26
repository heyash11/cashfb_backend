import type { Types } from 'mongoose';
import { ForbiddenError, NotFoundError } from '../../shared/errors/AppError.js';
import {
  SubscriptionModel,
  type SubscriptionAttrs,
} from '../../shared/models/Subscription.model.js';
import { UserModel, type UserAttrs } from '../../shared/models/User.model.js';

/**
 * `GET /api/v1/me` response payload (Phase 9.6). Identity-only —
 * the privacy posture documented in the chunk plan locks the
 * shape: no DOB, no declaredState, no email, no PAN ciphertext, no
 * DPDP-internal flags, no Mongoose internals. See controller for
 * the projection that enforces this at the query layer.
 */
export interface MeProfile {
  id: string;
  phone: string;
  tier: 'PUBLIC' | 'PRO' | 'PRO_MAX';
  coinBalance: number;
  displayName?: string;
  avatarUrl?: string;
  kyc: {
    status: 'NONE' | 'PENDING' | 'VERIFIED' | 'REJECTED';
    /**
     * Last four digits of the verified PAN. Surfaced ONLY when
     * `kyc.status === 'VERIFIED'` AND a value is actually stored.
     * Never surfaced for NONE/PENDING/REJECTED — that would leak
     * historical state of revoked verifications.
     */
    panLast4?: string;
  };
  subscription?: {
    status: 'ACTIVE' | 'CANCELLED' | 'EXPIRED';
    /** ISO 8601 — `User.tierExpiresAt` if set; absent otherwise. */
    expiresAt?: string;
  };
}

/**
 * Subset of User-row fields the profile service needs. Pulled via
 * explicit projection at the query layer so PAN ciphertext + DPDP
 * internals never enter memory.
 */
type UserProjection = Pick<
  UserAttrs,
  | '_id'
  | 'phone'
  | 'tier'
  | 'coinBalance'
  | 'displayName'
  | 'avatarUrl'
  | 'kyc'
  | 'blocked'
  | 'anonymizedAt'
  | 'activeSubscriptionId'
  | 'tierExpiresAt'
>;

export interface UserProfileServiceDeps {
  userModel?: typeof UserModel;
  subscriptionModel?: typeof SubscriptionModel;
  clock?: () => Date;
}

export class UserProfileService {
  private readonly userModel: typeof UserModel;
  private readonly subscriptionModel: typeof SubscriptionModel;
  private readonly clock: () => Date;

  constructor(deps: UserProfileServiceDeps = {}) {
    this.userModel = deps.userModel ?? UserModel;
    this.subscriptionModel = deps.subscriptionModel ?? SubscriptionModel;
    this.clock = deps.clock ?? (() => new Date());
  }

  /**
   * Hydrate the authenticated user's identity for UI rendering.
   *
   * Auth middleware (`requireUser`) has already verified the JWT +
   * checked the force-logout denylist in Redis, but does NOT read
   * the User document (Phase 9 Chunk 4 §A5 verdict — keeps requireUser
   * Mongo-free). `/me` is the first surface that hydrates the row;
   * we re-check anonymizedAt and blocked here as defense-in-depth
   * even though they should already be filtered upstream.
   */
  async getMe(userId: Types.ObjectId): Promise<MeProfile> {
    // Explicit projection — PAN ciphertext (panCt/panIv/panTag/panDekEnc),
    // DOB, declaredState, email, referralCode, deletedAt, erasureHold,
    // and Mongoose internals (__v) never enter memory. `.lean()` gives
    // us a plain JS object + ~40% perf vs hydrated docs at this volume.
    const user = (await this.userModel
      .findById(userId, {
        phone: 1,
        tier: 1,
        coinBalance: 1,
        displayName: 1,
        avatarUrl: 1,
        'kyc.status': 1,
        'kyc.panLast4': 1,
        blocked: 1,
        anonymizedAt: 1,
        activeSubscriptionId: 1,
        tierExpiresAt: 1,
      })
      .lean()) as UserProjection | null;

    if (!user) {
      throw new NotFoundError('User not found');
    }

    // Defense-in-depth: anonymized users SHOULD have invalid tokens
    // already (DPDP erasure request flow revokes sessions + writes
    // force-logout cutoff), but if a stale-but-still-live token
    // somehow makes it past requireUser, surface 404 here. Same
    // posture as auth.service.ts verifyLoginOtp.
    if (user.anonymizedAt) {
      throw new NotFoundError('User not found');
    }

    // Defense-in-depth: blocked users may still hold valid tokens
    // (block doesn't auto-revoke). Surface 403 USER_BLOCKED.
    if (user.blocked?.isBlocked === true) {
      throw new ForbiddenError('USER_BLOCKED', 'Account is blocked');
    }

    const subscription = user.activeSubscriptionId
      ? await this.resolveSubscription(user.activeSubscriptionId, user.tierExpiresAt)
      : undefined;

    const profile: MeProfile = {
      id: user._id.toHexString(),
      phone: user.phone,
      tier: user.tier,
      coinBalance: user.coinBalance,
      kyc: {
        status: user.kyc.status,
        ...(user.kyc.status === 'VERIFIED' && user.kyc.panLast4
          ? { panLast4: user.kyc.panLast4 }
          : {}),
      },
      ...(user.displayName ? { displayName: user.displayName } : {}),
      ...(user.avatarUrl ? { avatarUrl: user.avatarUrl } : {}),
      ...(subscription ? { subscription } : {}),
    };

    return profile;
  }

  /**
   * Map the 8-value backend `Subscription.status` enum down to the
   * 3-value client enum (`ACTIVE | CANCELLED | EXPIRED`) the UI
   * cares about, with a grace-period refinement on `CANCELLED`.
   *
   * Mapping (§A1 verdict):
   *   ACTIVE                                       → ACTIVE
   *   CANCELLED with tierExpiresAt > now()         → ACTIVE   ← grace
   *   CANCELLED with tierExpiresAt <= now()        → CANCELLED
   *   HALTED                                       → CANCELLED
   *   PAUSED                                       → CANCELLED
   *   COMPLETED                                    → EXPIRED
   *   CREATED / AUTHENTICATED / PENDING            → undefined (omit)
   *
   * Why grace-period maps to ACTIVE: the user's *functional* state
   * matters for UI, not Razorpay's internal lifecycle. A
   * cancelled-but-still-in-grace user is functionally Pro until the
   * grace ends. Returning ACTIVE keeps Pro features unlocked; the
   * `expiresAt` ISO timestamp lets the client render "expires on X"
   * messaging.
   *
   * Returns `undefined` to signal "omit the subscription block
   * entirely" — used for not-yet-usable subscription states
   * (CREATED/AUTHENTICATED/PENDING) so the UI doesn't render a
   * misleading "you have a subscription!" hint before the first
   * charge succeeds.
   */
  private async resolveSubscription(
    subscriptionId: Types.ObjectId,
    tierExpiresAt: Date | undefined,
  ): Promise<MeProfile['subscription'] | undefined> {
    const sub = await this.subscriptionModel
      .findById(subscriptionId, { status: 1 })
      .lean<Pick<SubscriptionAttrs, '_id' | 'status'> | null>();
    if (!sub) return undefined;

    let mapped: 'ACTIVE' | 'CANCELLED' | 'EXPIRED' | undefined;
    switch (sub.status) {
      case 'ACTIVE':
        mapped = 'ACTIVE';
        break;
      case 'CANCELLED':
        mapped =
          tierExpiresAt && tierExpiresAt.getTime() > this.clock().getTime()
            ? 'ACTIVE'
            : 'CANCELLED';
        break;
      case 'HALTED':
      case 'PAUSED':
        mapped = 'CANCELLED';
        break;
      case 'COMPLETED':
        mapped = 'EXPIRED';
        break;
      // CREATED / AUTHENTICATED / PENDING → omit (not yet usable)
      default:
        mapped = undefined;
    }

    if (!mapped) return undefined;
    return {
      status: mapped,
      ...(tierExpiresAt ? { expiresAt: tierExpiresAt.toISOString() } : {}),
    };
  }
}
