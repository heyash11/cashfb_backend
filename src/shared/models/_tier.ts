/**
 * Shared tier type for the parallel tier-scoped product model
 * (Phase 11.0). Used by new tier fields landing in this chunk:
 * `Vote.tier`, `PrizePool.tier`, `RedeemCode.tier`, and the
 * elements of `User.subscriptions[].tier`.
 *
 * Existing inline `'PUBLIC' | 'PRO' | 'PRO_MAX'` unions on
 * legacy fields (User.tier, Post.tierRequired, CustomRoom.tierRequired,
 * Subscription.tier, PrizePoolWinner.tier) are intentionally NOT
 * migrated to this shared type in 11.0 — that's a follow-up cleanup
 * once the parallel-tier migration has fully landed.
 */
export type Tier = 'PUBLIC' | 'PRO' | 'PRO_MAX';

/** Enum source for Mongoose schema definitions. */
export const TIER_VALUES = ['PUBLIC', 'PRO', 'PRO_MAX'] as const satisfies readonly Tier[];

/**
 * Subset usable as the tier of an active subscription. PUBLIC is
 * the default access state and is never represented as a row in
 * `User.subscriptions[]` — an empty array means PUBLIC-only.
 */
export type SubscribableTier = Exclude<Tier, 'PUBLIC'>;
export const SUBSCRIBABLE_TIER_VALUES = [
  'PRO',
  'PRO_MAX',
] as const satisfies readonly SubscribableTier[];

const TIER_RANK: Record<Tier, number> = { PUBLIC: 0, PRO: 1, PRO_MAX: 2 };

/**
 * Phase 11.1 — hierarchical access predicate. PRO_MAX subscribers
 * can vote in PRO_MAX/PRO/PUBLIC; PRO subscribers in PRO/PUBLIC;
 * PUBLIC users in PUBLIC only.
 *
 * This matches the legacy `posts.service.ts.tierAllowsAccess` and
 * `custom-rooms.service.ts.TIER_ORDER` semantics that gate single-
 * tier list endpoints. Phase 11.5 will replace this with a
 * subscriptions[]-based check on the User row, which flips the
 * semantic from "subscribed to a higher tier grants lower-tier
 * access" to "subscribed to a tier grants ONLY that tier" — the
 * parallel-section product model. Don't generalize this helper
 * across modules in 11.1; it lives here so the votes module can
 * adopt the new helper without touching posts/custom-rooms.
 */
export function tierGrantsAccess(userTier: Tier, requestedTier: Tier): boolean {
  return TIER_RANK[userTier] >= TIER_RANK[requestedTier];
}

/**
 * Phase 11.3 — `User.subscriptions[]` entry shape (mirrors
 * `UserSubscriptionEntry` in User.model.ts; duplicated here to
 * avoid a circular import with the model module). Webhook
 * handlers + sweep both depend on this derivation logic; they
 * don't need to import the full Mongoose model just for the
 * type.
 */
export interface DerivationSubscriptionEntry {
  tier: SubscribableTier;
  status: 'ACTIVE' | 'CANCELLED' | 'EXPIRED';
  expiresAt?: Date;
}

/**
 * Phase 11.3 — canonical "current tier" derivation rule. The
 * MongoDB aggregation pipeline used by the webhook handlers + sweep
 * service implements the same rule; the 12-row contract spec
 * (`_tier-derivation-contract.spec.ts`) asserts the two
 * implementations stay in lockstep.
 *
 * Rule:
 *   active(entry) = entry.status === 'ACTIVE'
 *                 OR (entry.status === 'CANCELLED' AND entry.expiresAt > now)
 *                 (CANCELLED-in-grace counts as active per /me semantics)
 *   tier =  'PRO_MAX' if any active PRO_MAX entry
 *           'PRO'     if any active PRO entry
 *           'PUBLIC'  otherwise
 *
 * EXPIRED status NEVER counts as active (sweep should have removed
 * the entry; defense-in-depth here for delayed sweep cycles).
 */
export function deriveCurrentTier(
  subs: ReadonlyArray<DerivationSubscriptionEntry>,
  now: Date,
): Tier {
  let hasActivePro = false;
  let hasActiveProMax = false;
  for (const entry of subs) {
    if (!isActiveForDerivation(entry, now)) continue;
    if (entry.tier === 'PRO_MAX') hasActiveProMax = true;
    else if (entry.tier === 'PRO') hasActivePro = true;
  }
  if (hasActiveProMax) return 'PRO_MAX';
  if (hasActivePro) return 'PRO';
  return 'PUBLIC';
}

/**
 * Phase 11.3 — derives the User.tierExpiresAt denormalization
 * companion to `deriveCurrentTier`. Returns the `expiresAt` of the
 * entry that DROVE the tier choice (highest active tier's expiry).
 * Returns `null` when the derived tier is PUBLIC.
 *
 * /me's grace-period mapping reads `user.tierExpiresAt` for the
 * subscription block's `expiresAt` field. Keeping this denormalized
 * value correlated with `tier` preserves /me's existing behavior
 * (verified in users.profile.service.ts §A1 grace verdict).
 */
export function deriveTierExpiresAt(
  subs: ReadonlyArray<DerivationSubscriptionEntry>,
  now: Date,
): Date | null {
  const activeProMax = subs.filter((s) => s.tier === 'PRO_MAX' && isActiveForDerivation(s, now));
  if (activeProMax.length > 0) return maxExpiresAt(activeProMax);
  const activePro = subs.filter((s) => s.tier === 'PRO' && isActiveForDerivation(s, now));
  if (activePro.length > 0) return maxExpiresAt(activePro);
  return null;
}

function isActiveForDerivation(entry: DerivationSubscriptionEntry, now: Date): boolean {
  if (entry.status === 'ACTIVE') return true;
  if (
    entry.status === 'CANCELLED' &&
    entry.expiresAt &&
    entry.expiresAt.getTime() > now.getTime()
  ) {
    return true;
  }
  return false;
}

function maxExpiresAt(entries: ReadonlyArray<DerivationSubscriptionEntry>): Date | null {
  let max: Date | null = null;
  for (const e of entries) {
    if (!e.expiresAt) continue;
    if (!max || e.expiresAt.getTime() > max.getTime()) max = e.expiresAt;
  }
  return max;
}
