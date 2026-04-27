# CashFB Product Model — Canonical Reference

This document defines the user-facing product model. Both backend and mobile reference this for any feature work. If the product model changes, update this file FIRST, then update implementations to match.

## Product summary

CashFB is a daily-prize redeem-code distribution app for Indian gaming users (BGMI, Free Fire). Users earn coins by watching ads, vote daily to determine the next day's prize pool, and claim Google Play redeem codes or compete in custom gaming rooms for prizes.

## Three subscription tiers

All three tiers see the same home-screen layout. They differ only in vote weight and prize multipliers:

| Tier    | Vote weight  | Custom room prize multiplier | Subscription duration |
| ------- | ------------ | ---------------------------- | --------------------- |
| PUBLIC  | 1 vote = ₹1  | ×1                           | Free, no expiry       |
| PRO     | 1 vote = ₹5  | ×5                           | 1 week (paid)         |
| PRO_MAX | 1 vote = ₹10 | ×10                          | 1 week (paid)         |

PRO and PRO_MAX subscriptions auto-expire after 1 week and require renewal. Backend grace-period logic still applies (CANCELLED + tierExpiresAt > now → ACTIVE in /me response).

## Core engagement loop

1. New user signs up → receives 3 coins free (signup bonus)
2. User watches a 5-second ad in the "Redeem Code" section → earns 1 coin per ad watched (calls POST /posts/:id/complete)
3. User accumulates coins
4. User casts ONE vote per day (costs 3 coins) → contributes to tomorrow's prize pool at their tier's multiplier
5. Next day, prize pool is computed from yesterday's total vote-weighted contribution
6. 70% of prize pool distributed via Google Play redeem codes (drops at scheduled times throughout the day)
7. 30% of prize pool distributed via custom BGMI/Free Fire gaming rooms (top 3 squads win prizes)

## Daily flow per user

- Morning: open app, see today's prize pool, see schedule of redeem code drops (5 PM, 6 PM, 7 PM, etc.)
- Throughout day: receive notifications when each drop is LIVE
- At drop time: tap OPEN → watch 5-sec ad → earn 1 coin → see redeem code list → copy code → paste into Google Play
- Once per day: cast a single vote (costs 3 coins) on a preferred redeem code or custom room target
- Evening: check custom room results (revealed 30 min after match start)

## Funding model

Two funding sources:

1. **User donations** via Razorpay (donation section on home, contributes to platform/future prize pools)
2. **Sponsor partnerships** (4 partner logos on top donor card; sponsors fund a portion of prize pools)

Currently donations are tracked, sponsor logos are placeholder until owner provides real partnership assets.

## Backend domain mapping

- **Post** model = a "redeem code drop" — scheduled time slot with admin-uploaded redeem codes
- **Post.coinReward** = coins earned for watching the 5-sec ad (currently 1)
- **Post.complete** endpoint = user finished the 5-sec ad, earns coinReward
- **Vote.target** = should reference Post.\_id (currently opaque, needs locking — see backend OPEN_DECISIONS)
- **TopDonorRanking** = donor leaderboard (5-min cron refresh)
- **CoinTransaction** = audit log of all coin movements
- **Subscription** = Pro / Pro Max paid tier (1-week duration)

## Open decisions

§PD1 — Custom Rooms model: backend currently lacks a CustomRoom model. Needs to be added in a backend chunk before Flutter custom-room screens can be built.

§PD2 — Redeem Code storage: backend Posts have coinReward but no redeem-code text storage. Need a separate RedeemCode model with batch upload from admin panel.

§PD3 — Prize Pool calculation: backend lacks the cron that computes "yesterday's votes × tier multiplier = today's prize pool." Needs a daily cron.

§PD4 — Subscription duration: verify backend's current default is 1 week, not 1 month. Update if needed.

§PD5 — Tier multiplier on vote weight: when a Pro user votes, backend currently records the same vote-weight regardless of tier. Need to add tier multiplier to vote service.

§PD6 — Custom room result reveal: backend lacks the "30-min post-match reveal" gating. Result endpoint should return "pending" for 30 min after match start.

§PD7 — Cross-tier visibility: do Pro homes show the same top donor card as Public homes, or different? Currently spec'd identical.

§PD8 — Bottom nav UX: do Public users see grayed Pro/Pro Max tabs (with "upgrade to access"), or hidden tabs?

## Reference dates

- Product model documented: 2026-04-26
- Last updated: 2026-04-26
- Owner: Ashutosh "Ashhu" Patil
