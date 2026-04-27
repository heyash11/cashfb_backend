import type { Types } from 'mongoose';
import { ForbiddenError, NotFoundError } from '../../shared/errors/AppError.js';
import {
  UserModel,
  type UserAttrs,
  type UserSubscriptionEntry,
} from '../../shared/models/User.model.js';
import { deriveCurrentTier, type Tier } from '../../shared/models/_tier.js';

/**
 * `GET /api/v1/me` response payload.
 *
 * Phase 11.5 — Shape change (BREAKING vs Phase 9.6):
 *   REMOVED: `tier` (singular) — replaced by `currentTier`.
 *   REMOVED: `subscription` (singular) — replaced by `subscriptions[]`.
 *   ADDED:   `subscriptions: SubscriptionEntry[]` — full array from
 *            `User.subscriptions[]` (Phase 11.0 schema). Empty array
 *            means PUBLIC-only.
 *   ADDED:   `currentTier: Tier` — derived via `deriveCurrentTier`
 *            (highest active tier, with grace-period rule). Display-
 *            only convenience for UI header chip; subscriptions[]
 *            is the truth for access decisions.
 *
 * The single-tier convenience fields led to the original §A12 bug
 * (PRO_MAX-only being indistinguishable from PRO+PRO_MAX from one
 * number). The array is now authoritative.
 *
 * Privacy posture unchanged: no DOB, no declaredState, no email,
 * no PAN ciphertext, no DPDP-internal flags.
 */
export interface MeSubscriptionEntry {
  tier: 'PRO' | 'PRO_MAX';
  status: 'ACTIVE' | 'CANCELLED' | 'EXPIRED';
  /** ISO 8601 — entry's expiresAt if set; absent otherwise. */
  expiresAt?: string;
}

export interface MeProfile {
  id: string;
  phone: string;
  coinBalance: number;
  displayName?: string;
  avatarUrl?: string;
  kyc: {
    status: 'NONE' | 'PENDING' | 'VERIFIED' | 'REJECTED';
    /**
     * Last four digits of the verified PAN. Surfaced ONLY when
     * `kyc.status === 'VERIFIED'` AND a value is actually stored.
     */
    panLast4?: string;
  };
  /**
   * Phase 11.5 — full subscriptions array. Empty = PUBLIC-only.
   */
  subscriptions: MeSubscriptionEntry[];
  /**
   * Phase 11.5 — derived "headline tier" for UI display. Same rule
   * as `deriveCurrentTier`: PRO_MAX wins → PRO wins → PUBLIC. This
   * is a derived view, NOT a stored field. Authorization decisions
   * MUST go through `userCanAccessTier(subscriptions, requestedTier)`
   * — never through this convenience.
   */
  currentTier: Tier;
}

/**
 * Subset of User-row fields the profile service needs.
 */
type UserProjection = Pick<
  UserAttrs,
  | '_id'
  | 'phone'
  | 'coinBalance'
  | 'displayName'
  | 'avatarUrl'
  | 'kyc'
  | 'blocked'
  | 'anonymizedAt'
  | 'subscriptions'
>;

export interface UserProfileServiceDeps {
  userModel?: typeof UserModel;
  clock?: () => Date;
}

export class UserProfileService {
  private readonly userModel: typeof UserModel;
  private readonly clock: () => Date;

  constructor(deps: UserProfileServiceDeps = {}) {
    this.userModel = deps.userModel ?? UserModel;
    this.clock = deps.clock ?? (() => new Date());
  }

  /**
   * Hydrate the authenticated user's identity for UI rendering.
   *
   * Phase 11.5 — `requireUser` middleware now fetches the User row
   * during JWT verification (for tokenVersion check). The
   * controller could pass `req.user.subscriptions` directly to save
   * a duplicate fetch, but `/me` still needs phone, displayName,
   * avatar, kyc, etc. — fields that aren't on `req.user`. So we
   * pay the second read here, with a tight projection.
   */
  async getMe(userId: Types.ObjectId): Promise<MeProfile> {
    const user = (await this.userModel
      .findById(userId, {
        phone: 1,
        coinBalance: 1,
        displayName: 1,
        avatarUrl: 1,
        'kyc.status': 1,
        'kyc.panLast4': 1,
        blocked: 1,
        anonymizedAt: 1,
        subscriptions: 1,
      })
      .lean()) as UserProjection | null;

    if (!user) {
      throw new NotFoundError('User not found');
    }

    if (user.anonymizedAt) {
      throw new NotFoundError('User not found');
    }

    if (user.blocked?.isBlocked === true) {
      throw new ForbiddenError('USER_BLOCKED', 'Account is blocked');
    }

    const subs = user.subscriptions ?? [];
    const now = this.clock();
    const subscriptions = subs.map((entry) => mapEntry(entry));
    const currentTier = deriveCurrentTier(subs, now);

    const profile: MeProfile = {
      id: user._id.toHexString(),
      phone: user.phone,
      coinBalance: user.coinBalance,
      kyc: {
        status: user.kyc.status,
        ...(user.kyc.status === 'VERIFIED' && user.kyc.panLast4
          ? { panLast4: user.kyc.panLast4 }
          : {}),
      },
      ...(user.displayName ? { displayName: user.displayName } : {}),
      ...(user.avatarUrl ? { avatarUrl: user.avatarUrl } : {}),
      subscriptions,
      currentTier,
    };

    return profile;
  }
}

function mapEntry(entry: UserSubscriptionEntry): MeSubscriptionEntry {
  const out: MeSubscriptionEntry = {
    tier: entry.tier,
    status: entry.status,
  };
  if (entry.expiresAt) out.expiresAt = entry.expiresAt.toISOString();
  return out;
}
