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
