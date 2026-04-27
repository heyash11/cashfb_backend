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
