# CashFB Product Model — Canonical Reference

This document defines the user-facing product model. Both backend and mobile reference this for any feature work. If the product model changes, update this file FIRST, then update implementations to match.

## Product summary

CashFB is a daily-prize redeem-code distribution app for Indian gaming users (BGMI, Free Fire). Users earn coins by watching ads, vote daily across one or more tier sections, and claim Google Play redeem codes or compete in custom gaming rooms for tier-scoped prizes.

## Three parallel tier sections

The app has three independent tier sections, each with its own home screen, vote slot, redeem code drops, custom rooms, prize pool, and leaderboard. Subscriptions UNLOCK access to their respective sections.

| Section | Access                 | Vote weight | Custom room multiplier | Subscription cost (weekly) |
| ------- | ---------------------- | ----------- | ---------------------- | -------------------------- |
| PUBLIC  | All users (free)       | ×1          | ×1                     | Free, no expiry            |
| PRO     | Active PRO subscribers | ×5          | ×5                     | ₹50 + 28% GST = ₹64        |
| PRO_MAX | Active PRO_MAX subs    | ×10         | ×10                    | ₹100 + 28% GST = ₹128      |

PUBLIC is always accessible. PRO and PRO_MAX require active weekly subscriptions purchased separately. Subscriptions auto-expire after 7 days; renewal required for continued access.

## Subscription stacking

Users can hold MULTIPLE subscriptions simultaneously:

- PUBLIC only (default for all users)
- PUBLIC + PRO
- PUBLIC + PRO_MAX
- PUBLIC + PRO + PRO_MAX (full access at ₹192/week)

Each subscription unlocks its tier's section independently. A user with PRO + PRO_MAX can vote in PUBLIC, PRO, and PRO_MAX sections separately on the same day.

## Core engagement loop (per tier section)

Each tier section operates the same loop independently:

1. New user signs up → receives 3 coins free (signup bonus, one-time, shared coin wallet across all tier sections)
2. User watches a 5-second ad in a tier's "Redeem Code" section → earns 1 coin per ad watched (calls POST /posts/:id/complete)
3. User accumulates coins (single shared wallet across tiers)
4. User casts ONE vote per day per accessible tier section (costs 3 coins per vote, contributes to that tier's prize pool at the tier's vote weight)
5. Next day, each tier's prize pool is computed from yesterday's total votes in that tier × tier's vote weight × baseRate
6. 70% of each tier's pool distributed via Google Play redeem codes (drops at scheduled times throughout the day, scoped to that tier's subscribers)
7. 30% of each tier's pool distributed via custom BGMI/Free Fire gaming rooms (top 3 squads win prizes, tier-scoped rooms)

## Vote economics

| User profile           | Daily votes possible | Total daily coin cost |
| ---------------------- | -------------------- | --------------------- |
| PUBLIC only            | 1 (in PUBLIC)        | 3 coins               |
| PUBLIC + PRO           | 2 (PUBLIC + PRO)     | 6 coins               |
| PUBLIC + PRO_MAX       | 2 (PUBLIC + PRO_MAX) | 6 coins               |
| PUBLIC + PRO + PRO_MAX | 3 (all sections)     | 9 coins               |

Votes are independent — voting in PUBLIC does not consume the PRO or PRO_MAX vote slot.

## Daily flow per user

- Morning: open app, lands on PUBLIC home (default)
- Browse PUBLIC section: see today's prize pool, redeem code schedule, custom rooms, top donor card, vote button
- If subscribed to PRO: tap PRO tab → see PRO section with PRO-scoped data (different prize pool, different drops, different rooms, different leaderboard, different vote slot)
- If subscribed to PRO_MAX: tap PRO_MAX tab → similar but PRO_MAX-scoped
- Throughout day: receive notifications for drops in subscribed tiers
- At drop time: tap OPEN → watch 5-sec ad → earn 1 coin → see redeem code list (tier-scoped) → copy code → paste into Google Play
- Once per day per subscribed tier: cast a vote (costs 3 coins per vote)
- Evening: check tier-specific custom room results

## Bottom navigation behavior

Three tabs always visible: PUBLIC | PRO | PRO_MAX

- Tap PUBLIC → always navigates to PUBLIC home
- Tap PRO with active PRO subscription → PRO home
- Tap PRO with no PRO subscription → subscription pricing modal (silver-styled card for PRO, gold-styled card for PRO_MAX, both options shown so user can compare)
- Tap PRO_MAX with active PRO_MAX subscription → PRO_MAX home
- Tap PRO_MAX with no PRO_MAX subscription → same pricing modal

The pricing modal lets users buy any tier from any locked tab.

## Funding model

Each tier's prize pool is funded by:

1. **User donations** via Razorpay (donations contribute to PUBLIC pool only, since donations are platform-wide and don't have tier scoping)
2. **Subscription revenue** — PRO/PRO_MAX subscriptions contribute to their respective tier pools
3. **Sponsor partnerships** — sponsor logos appear on top donor card across all tiers (placeholder until owner provides real partnership assets)

Pool computation per tier:

- PUBLIC pool: yesterday's PUBLIC vote count × ×1 × baseRate (₹1)
- PRO pool: yesterday's PRO vote count × ×5 × baseRate (₹1)
- PRO_MAX pool: yesterday's PRO_MAX vote count × ×10 × baseRate (₹1)

(Vote weight is applied at pool computation time, sourced from the user's tier at that section's pool — i.e., a vote cast in PRO section is automatically a ×5 vote.)

## Backend domain mapping

- **User.subscriptions[]** — array of active subscriptions ({tier: 'PRO'|'PRO_MAX', expiresAt: Date}). Empty array = PUBLIC-only.
- **Post** — a redeem code drop, scoped to a tier (Post.tier: 'PUBLIC'|'PRO'|'PRO_MAX')
- **Post.coinReward** — coins earned for watching the 5-sec ad (currently 1)
- **Vote** — single vote per user per tier per day. Schema has unique index on (userId, tier, dayKey).
- **Vote.target** — opaque string. Flutter convention: Post.\_id hex (redeem code drops) or CustomRoom.\_id hex (custom rooms). Backend doesn't enforce FK.
- **CustomRoom** — gaming room scoped to a tier (CustomRoom.tier: 'PUBLIC'|'PRO'|'PRO_MAX')
- **PrizePool** — one row per (tier, dayKey). Independent pools per tier per day.
- **TopDonorRanking** — platform-wide donor leaderboard (NOT tier-scoped per §PD7 verdict). Same leaderboard shown on all three tier homes.
- **CoinTransaction** — audit log of all coin movements (shared coin wallet, no tier scoping needed)
- **Subscription** — Razorpay-managed weekly subscription per (user, tier). User can have multiple active subscriptions in parallel.

## Open decisions

§PD1 — Custom Rooms model: Backend has CustomRoom model. TIER FIELD STATUS UNVERIFIED — needs verification that CustomRoom has a `tier` field for scoping.

§PD2 — Redeem Code storage: Backend has RedeemCode + RedeemCodeBatch models. TIER FIELD STATUS UNVERIFIED — needs verification that RedeemCode has a `tier` field for scoping.

§PD3 — Prize Pool calculation: Backend has prize-pool-daily cron. NEEDS REWORK — currently computes one pool per day across all tiers. Must be reworked to compute three pools per day (one per tier) using each tier's vote count.

§PD4 — Subscription duration: Confirmed weekly via Razorpay plan period: weekly, interval: 1.

§PD5 — Tier multiplier on vote weight: PARTIALLY OBSOLETE. Phase 10.1 implemented tier-weighted single pool. Now needs rework to per-tier independent pools (still tier-aware, but the math is "votes in PRO tier × ×5" rather than "all votes weighted by voter tier"). The Vote schema needs a `tier` field to know which pool the vote contributes to.

§PD6 — Custom room result reveal gating: Implemented (30-min delay). No change needed.

§PD7 — Cross-tier visibility: RESOLVED. Same Top Donor card shown across all three tier homes. Donor leaderboard remains platform-wide (not tier-scoped).

§PD8 — Bottom nav UX: RESOLVED. Three tabs always visible. Inaccessible tier tap → subscription pricing modal showing both PRO (silver) and PRO_MAX (gold) cards.

§PD9 — Vote.target convention: Flutter enforces target = Post.\_id hex (redeem code drops) or CustomRoom.\_id hex (custom rooms). Backend treats as opaque string.

§PD10 — User.subscriptions schema: Backend currently has single User.tier field plus single User.activeSubscriptionId. Needs rework to support multiple active subscriptions in parallel (PUBLIC + PRO + PRO_MAX scenarios).

§PD11 — Vote schema tier field: Vote currently has unique index (userId, dayKey) → enforces one vote per day across all tiers. Needs rework to (userId, tier, dayKey) → enforces one vote per tier per day.

§PD12 — Tier scoping on Posts/RedeemCodes/CustomRooms: Verify or add tier field. List endpoints need to filter by the requesting user's accessible tiers.

§PD13 — /me endpoint expansion: Currently returns single tier. Needs to return list of active subscriptions:

```
{
  subscriptions: [
    {tier: 'PRO', status: 'ACTIVE', expiresAt: '...'},
    {tier: 'PRO_MAX', status: 'ACTIVE', expiresAt: '...'}
  ]
}
```

Empty array = PUBLIC-only access.

## Phase 10.1 obsolescence note

Phase 10.1 (commit 6b26be4) implemented tier-weighted single-pool aggregation. The product is now confirmed to be three independent tier-scoped pools instead of one weighted pool. Phase 10.1's $lookup-driven aggregation infrastructure is reusable for the new model (still needs to look up user.tier per vote), but the pool entity itself shifts from one-row-per-day to one-row-per-tier-per-day.

## Reference dates

- Product model documented: 2026-04-26
- Major re-baseline (parallel tier sections): 2026-04-26
- Last updated: 2026-04-26
- Owner: Ashutosh "Ashhu" Patil
