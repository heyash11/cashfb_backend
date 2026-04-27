import type { Types } from 'mongoose';
import { logger } from '../../config/logger.js';
import {
  SubscriptionModel,
  type SubscriptionAttrs,
} from '../../shared/models/Subscription.model.js';
import { UserModel } from '../../shared/models/User.model.js';
import type { SubscribableTier } from '../../shared/models/_tier.js';

export interface UserSubscriptionsBackfillReport {
  collection: string;
  scanned: number;
  updated: number;
  skipped: number;
  /**
   * Users with `tier !== 'PUBLIC'` but no resolvable
   * `activeSubscriptionId`. They land with `subscriptions: []`
   * (no entry pushed) and a structured warn log per the §R4
   * verdict so operators can audit via a future cleanup chore.
   */
  anomalyCount: number;
  anomalyUsers: string[];
}

type SubProjection = Pick<SubscriptionAttrs, '_id' | 'status'>;

/**
 * Map the 8-value backend Subscription.status enum down to the
 * 3-value client enum stored on `User.subscriptions[]`. Mirrors
 * the §A1 grace-period logic used by `users.profile.service.ts`
 * so the re-baseline writes the same status the live /me endpoint
 * would surface.
 *
 * Returns `undefined` for not-yet-usable states (CREATED /
 * AUTHENTICATED / PENDING) — backfill skips those users entirely
 * so their array stays empty, matching today's /me behavior of
 * omitting the subscription block until first charge succeeds.
 */
export function mapSubscriptionStatusForBackfill(
  raw: SubscriptionAttrs['status'],
  tierExpiresAt: Date | undefined,
  now: Date,
): 'ACTIVE' | 'CANCELLED' | 'EXPIRED' | undefined {
  switch (raw) {
    case 'ACTIVE':
      return 'ACTIVE';
    case 'CANCELLED':
      return tierExpiresAt && tierExpiresAt.getTime() > now.getTime() ? 'ACTIVE' : 'CANCELLED';
    case 'HALTED':
    case 'PAUSED':
      return 'CANCELLED';
    case 'COMPLETED':
      return 'EXPIRED';
    default:
      return undefined;
  }
}

/**
 * Phase 11.0 — backfill `User.subscriptions[]` from legacy
 * single-field state (`tier`, `activeSubscriptionId`,
 * `tierExpiresAt`). §A4 verdict: faithful translation, no invented
 * state.
 *
 * Idempotent: skip users whose `subscriptions` array already
 * contains an entry for the legacy tier.
 *
 * Anomaly path (§R4): users with `tier !== 'PUBLIC'` but no
 * `activeSubscriptionId` get logged as anomalies and skipped.
 * Backfill never touches their legacy fields.
 */
export async function runBackfillUserSubscriptions(
  clock: () => Date = () => new Date(),
): Promise<UserSubscriptionsBackfillReport> {
  const now = clock();

  // Working set: users on a non-PUBLIC tier. Includes anomalies
  // (no activeSubscriptionId) so we can log them.
  //
  // Phase 11.5 — the legacy tier/activeSubscriptionId/tierExpiresAt
  // fields no longer exist on the User schema. This backfill ran
  // ONCE during 11.0 dev migration and will run once on prod
  // BEFORE the 11.5 field drop. After 11.5 ships, it becomes
  // inert (no users match `tier: {$ne: 'PUBLIC'}` because there's
  // no `tier` field). The collection-level driver bypasses
  // Mongoose schema strictness so the field-presence query still
  // works on un-migrated rows.
  const candidates = (await UserModel.collection
    .find(
      { tier: { $ne: 'PUBLIC' } },
      {
        projection: {
          _id: 1,
          tier: 1,
          activeSubscriptionId: 1,
          tierExpiresAt: 1,
          subscriptions: 1,
        },
      },
    )
    .toArray()) as unknown as Array<{
    _id: Types.ObjectId;
    tier?: SubscribableTier | 'PUBLIC';
    activeSubscriptionId?: Types.ObjectId;
    tierExpiresAt?: Date;
    subscriptions?: Array<{ tier: SubscribableTier }>;
  }>;

  const scanned = candidates.length;
  let updated = 0;
  let skipped = 0;
  const anomalyUsers: string[] = [];

  for (const user of candidates) {
    const userId = user._id as Types.ObjectId;
    const legacyTier = user.tier as SubscribableTier;

    // Idempotency: array already contains an entry for this tier.
    const alreadyPresent =
      Array.isArray(user.subscriptions) && user.subscriptions.some((s) => s.tier === legacyTier);
    if (alreadyPresent) {
      skipped++;
      continue;
    }

    // Anomaly: non-PUBLIC tier without a Subscription pointer.
    if (!user.activeSubscriptionId) {
      anomalyUsers.push(String(userId));
      skipped++;
      continue;
    }

    const sub = (await SubscriptionModel.findById(user.activeSubscriptionId, {
      _id: 1,
      status: 1,
    }).lean()) as SubProjection | null;

    if (!sub) {
      // Pointer set but Subscription doc missing — also anomaly.
      anomalyUsers.push(String(userId));
      skipped++;
      continue;
    }

    const mapped = mapSubscriptionStatusForBackfill(sub.status, user.tierExpiresAt, now);
    if (!mapped) {
      // Not-yet-usable subscription state. Match /me's omit-block
      // posture; user.subscriptions stays empty.
      skipped++;
      continue;
    }

    const entry: {
      tier: SubscribableTier;
      status: 'ACTIVE' | 'CANCELLED' | 'EXPIRED';
      subscriptionId: Types.ObjectId;
      expiresAt?: Date;
    } = {
      tier: legacyTier,
      status: mapped,
      subscriptionId: sub._id,
    };
    if (user.tierExpiresAt) entry.expiresAt = user.tierExpiresAt;

    await UserModel.updateOne({ _id: userId }, { $push: { subscriptions: entry } });
    updated++;
  }

  if (anomalyUsers.length > 0) {
    logger.warn(
      {
        msg: 'User subscriptions backfill complete with anomalies',
        anomalyUsers,
        count: anomalyUsers.length,
        action:
          'These users have non-PUBLIC tier but no resolvable activeSubscriptionId. Investigate via scripts/audit-orphan-pro-users.ts (future chore).',
      },
      '[backfill:user-subscriptions] anomalies',
    );
  }

  const report: UserSubscriptionsBackfillReport = {
    collection: 'users',
    scanned,
    updated,
    skipped,
    anomalyCount: anomalyUsers.length,
    anomalyUsers,
  };
  logger.info(report, '[backfill:user-subscriptions] complete');
  return report;
}
