# OPEN_DECISIONS.md

Specific decisions the project owner must close before or during specific development phases. Each item lists which phase it blocks and a recommended default. Do not write code for an affected area until the decision is closed.

When a decision is closed, move it from "Open" to "Closed", record the date and the resolution, and update any dependent doc.

---

## Status legend

- :red_circle: **Open**. Blocks the referenced phase.
- :yellow_circle: **Pending**. Owner has been asked, awaiting answer.
- :green_circle: **Closed**. Decision locked, date + resolution recorded.

---

## 1. PROGA 2025 legal opinion

**Status:** :red_circle: Open
**Blocks:** Phase 6 tournaments, any subscription-gated contest access
**Recommended default:** Feature-flag both paths off. Ship ads-only free contest on day one.

The Promotion and Regulation of Online Gaming Act 2025 (Presidential assent 22 Aug 2025) prohibits "online money games" nationally and removes the "game of skill" defence. Two CashFB features sit near the line:

- (a) BGMI / Free Fire custom-room tournaments with monetary or monetary-equivalent prizes.
- (b) Gift-card contest **when access is gated behind a paid Pro / Pro Max subscription** (subscription = deposit, gift card = in-kind winnings).

The free-entry gift-card contest with ad-funded prizes is defensible as a promotional contest with no consideration.

**Action needed:** Engage a tech-law counsel familiar with PROGA 2025 and any subsequent OGAI guidance. Get a written opinion on whether the subscription-gated contest model is defensible under the current draft rules.

**Blocker impact:** `featureFlags.tournaments` and `featureFlags.proContestAccess` default `false`. Feature flags live in `app_config.featureFlags`. Flipping to `true` requires SUPER_ADMIN and counsel sign-off recorded in `audit_logs`.

---

## 2. Prize pool base rate

**Status:** :green_circle: Closed on 2026-04-23
**Resolution:** Shipped Phase 6 with default 100 paise per vote, tuneable via `AppConfig.baseRatePerVote` without redeploy. 70/30 split: `floor(0.7 × total)` for gift codes, remainder for custom rooms (odd-paisa residue absorbed into the custom-room budget, same pattern as SGST in the GST splitter). Auto-scaling against ad revenue deferred — real tuning happens from production data post-launch; the default + override mechanism matters more than the number.
**Implementer:** `src/modules/prize-pools/prize-pools.service.ts` `computeAndPublishPool`.
**Linked commit:** `feat(prize-pools): daily pool computation primitive with pattern-1 idempotency` (local, not yet pushed).

---

## 3. Subscription billing cycle

**Status:** :red_circle: Open
**Blocks:** Phase 5 Razorpay plan migration
**Recommended default:** Monthly only at launch. Add yearly in a post-launch iteration if demand emerges.

If yearly is desired, we create a second Razorpay plan per tier:

- Pro Yearly: ₹600 + 18% GST = ₹708
- Pro Max Yearly: ₹1200 + 18% GST = ₹1416

**Action needed:** Owner confirms "monthly only" or specifies yearly price points.

---

## 4. Multiplier semantics (5x / 10x)

**Status:** :green_circle: Closed on 2026-04-23
**Resolution:** Phase 6 ships Option A (multiple-code multiplier). `PrizePoolWinner.multiplier` field semantics: number of codes awarded. PUBLIC×1, PRO×5, PRO_MAX×10 (from `AppConfig.proMultiplier` / `proMaxMultiplier`, defaults locked in code). Refactor path to Option B is available — the multiplier field would shift to represent pool scaling and `PrizePoolService.computeAndPublishPool` would grow pool-per-tier logic. Not a dead end.
**Implementer:** `src/modules/custom-rooms/custom-rooms.admin.service.ts` `assignWinners`.
**Linked commit:** `feat(custom-rooms): user + admin services with state-predicated transitions` (local, not yet pushed).

### Original question

Two possible interpretations of the 5x / 10x multiplier:

- **Option A:** Pro winner of a ₹50 gift code receives 5 codes worth ₹250 total. Pro Max receives 10 codes worth ₹500.
- **Option B:** Pro users compete in a separate, larger pool (5x the public pool size).

Architecture supports both via `PrizePoolWinner.multiplier`. UX differs significantly.

---

## 5. Ad networks at launch

**Status:** :red_circle: Open
**Blocks:** Phase 0 (minor, ads config can be populated later)
**Recommended default:** AdMob day-one, AppLovin or Unity ready as second network.

Architecture is ad-network-agnostic. Backend stores placement key with network + unit IDs. Flutter app plugs in via adapter.

**Action needed:** Owner confirms AdMob. Owner signs up for AdMob publisher account, creates 6 placements:

- `home_top_banner`
- `timer_top_banner`
- `timer_bottom_banner`
- `redeem_code_bottom_banner`
- `custom_room_bottom_banner`
- `result_middle_banner`

Then provide the ad unit IDs (Android + iOS). We enter them in the admin panel `ads_config`.

---

## 6. KYC threshold

**Status:** :white_check_mark: CLOSED (Phase 8 Chunk 4)
**Default:** ₹10,000 (1,000,000 paise). Schema default in `AppConfig.kycThresholdAmount`. Existing environments migrate via the mongosh update documented in `ADMIN_OPERATIONS.md` §Setup. Runtime override via `PATCH /api/v1/admin/app-config`.

Compliance framing kept intact: TDS §194BA applies on prize payouts; having PAN on file before payout is both TDS-practical and a fraud deterrent. The ₹10,000 threshold is high enough that routine sub-₹100 trivia rewards don't trigger the gate, low enough that payouts reaching regulatory interest levels do.

**Closed by:** Phase 8 Chunk 4 commit — gate implementation at `KycService.evaluateGate` + `RedeemCodeService.claim`.

---

## 7. Refund policy

**Status:** :red_circle: Open
**Blocks:** Phase 5 user self-refund endpoint + user-facing copy in `cms_content.TERMS`. Does NOT block the admin-only refund path (already landed in Phase 5 Chunk 4 via `RefundService.initiateRefund`).
**Recommended default:** 7-day no-questions refund on first subscription charge. No refund on renewal charges. Pro-rated refund if cancelled within 24 h of renewal on a support-ticket basis.

**Phase 5 status (2026-04-23):** Admin-initiated refund shipped via `RefundService.initiateRefund(paymentId, reason, actorId, amountPaise?, cancelSubscription?)`. Wired to `rzp.payments.refund` + conditional `rzp.subscriptions.cancel` per PAYMENTS.md §7. Webhook handler `onRefundProcessed` flips `SubscriptionPayment.status` to `REFUNDED` / `PARTIAL_REFUND` with idempotent status predicate. Tier downgrade flows through the ensuing `subscription.cancelled` cascade (no duplication). User self-refund DEFERRED — not exposed on any user route.

**Action needed:** Owner approves the 7-day policy text. Once approved: (a) legal text into `cms_content.TERMS`, (b) user-facing `POST /me/subscriptions/:id/refund` endpoint with 7-day window enforcement, (c) pro-rated calculation for the 24h-after-renewal support path. Status stays 🔴 until (a) lands.

---

## 8. Bot detection vendor

**Status:** :red_circle: Open
**Blocks:** Phase 2 (OTP endpoint hardening)
**Recommended default:** Cloudflare Turnstile (free, privacy-friendly) on OTP request endpoints. Arkose Labs as paid upgrade if fraud volume warrants it.

**Action needed:** Owner approves Turnstile. We add the JS challenge on the signup + login OTP request flows in the Flutter app.

---

## 9. Push notification provider

**Status:** :yellow_circle: Pending (FCM assumed)
**Blocks:** Phase 7 (push broadcast)
**Recommended default:** FCM via Firebase Admin SDK.

**Action needed:** Owner creates Firebase project, downloads service account JSON, uploads to SSM. For iOS (later): upload APNs key to FCM console.

---

## 10. Google Play gift card supplier

**Status:** :red_circle: Open
**Blocks:** Phase 4 (first code batch upload)
**Recommended default:** Xoxoday or Qwikcilver, based on whichever gives better pricing in INR.

Options (all Google-authorised B2B resellers in India):

- **Xoxoday**. Bengaluru-based, wide SKU range, API available.
- **Plum (by QwikCilver)**. Same parent company, slightly different SKU.
- **Zaggle**. Enterprise-focused.
- **Qwikcilver** (Pine Labs). Oldest in the space, strong relationships.
- **Pine Labs**. Same parent as Qwikcilver.

**Action needed:** Owner engages with 2 to 3 suppliers, gets pricing quotes, completes KYB, opens account. Supplier invoices must be saved per batch in `redeem_code_batches.supplierInvoiceUrl`.

**Do not bulk-buy from consumer marketplaces (Amazon, Flipkart).** Google's resale terms prohibit this and may void the codes.

---

## 11. Grievance Officer

**Status:** :red_circle: Open
**Blocks:** Prod launch (IT Rules 2021 requires published Grievance Officer contact)
**Recommended default:** Owner appoints themselves or a senior team member.

Required per IT Rules 2021 and DPDP Act 2023. Must be:

- Named individual (not a role inbox).
- Indian resident.
- Contactable via email and phone.
- Published in-app and on marketing site.

**Action needed:** Owner provides:

- Full name
- Designation
- Email
- Phone
- Postal address

Goes into `cms_content.GRIEVANCE` and surfaces at `GET /cms/grievance`.

---

## 12. Merchant GSTIN and state

**Status:** :red_circle: Open
**Blocks:** Phase 5 (GST invoice generation)
**Recommended default:** None. Must be provided.

Invoice generation on every `subscription.charged` needs:

- Merchant legal name (registered entity name).
- Merchant GSTIN (15-character).
- Merchant registered state (ISO 3166-2:IN code, e.g. `IN-MH` for Maharashtra).
- Merchant registered address.

Place of supply is the user's declared state. Intra-state uses CGST + SGST split. Inter-state uses IGST.

**Action needed:** Owner provides registration details. If entity is not yet registered for GST, start the process immediately. If annual turnover exceeds ₹20 lakh (or ₹40 lakh in some states), registration is mandatory.

---

## 13. DPDP erasure schema design

**Status:** :red_circle: Open
**Blocks:** DPDP compliance work (post-MVP phase; does NOT block Phase 1).
**Recommended default:** Add `deletedAt: Date` and `anonymizedAt: Date` to `users`. 30-day grace via a daily `user-anonymize-sweep` cron. On anonymisation, overwrite phone/email/displayName/avatarUrl/socialLinks/PAN ciphertext with nulls or hashed tombstones; keep `_id` and `createdAt` for referential integrity.

The `DELETE /me` endpoint (SECURITY.md §10) and the DPDP Act erasure requirement need a durable schema story. Not plumbed in Phase 1 to avoid speculative fields. Three sub-questions the owner should close:

1. Does the same `deletedAt`/`anonymizedAt` pair belong on `donations`? Donor name, displayName, and socialLinks are PII even after the user is gone.
2. For `audit_logs`, `coin_transactions`, `prize_pool_winners` (which reference `userId`): erase the user's presence, or retain for integrity/regulatory purposes? Counsel should weigh in, especially for prize records (TDS 194BA retention).
3. Is 30-day grace acceptable under DPDP, or does the owner prefer 7 days / immediate erasure with a confirmation step?

**Action needed:** Owner confirms the field set, grace window, and which collections receive erasure fields. Once closed, add the fields to the relevant models and wire the sweep cron in Phase 7 or a dedicated compliance phase.

---

## 14. MSG91 DLT template ID + sender ID registration

**Status:** :red_circle: Open
**Blocks:** Prod launch. Does NOT block Phase 2 development (DevConsole sender ships as the default).
**Recommended default:** Register a single "login / signup OTP" DLT template with TRAI, plus a DLT-approved 6-char sender ID, and wire both into Secrets Manager.

The MSG91 adapter is in the codebase and env-gated on `OTP_SENDER=msg91` plus `MSG91_AUTH_KEY` / `MSG91_TEMPLATE_ID` / `MSG91_SENDER_ID`. Until a DLT template is registered and approved (TRAI takes ~2 to 7 business days), OTPs cannot legally dispatch to Indian phones from prod — dev and staging use the DevConsole sender which logs the OTP instead of sending.

**Action needed:** Owner completes DLT registration, receives template + sender IDs, stores them in Secrets Manager and SSM. `.env.example` already has the variable names in place.

---

## 15. Replace InferSchemaType with explicit typed interfaces across all 27 models

**Status:** :green_circle: Closed on 2026-04-22
**Resolution:** All 27 `*.model.ts` files now export a hand-written `XyzAttrs` interface that includes `_id: Types.ObjectId`, `createdAt` / `updatedAt` where applicable, correctly typed `Types.ObjectId` ref fields, and required-at-schema-level fields typed as `T` (not `T | null | undefined`). Subdocs with inner defaults typed as required; genuinely optional subdocs typed optional. Shared `SocialLinks` extracted to `src/shared/models/_shared.ts`. All nine workaround sites (9 `TODO(schema-types)` markers, the `leanId` helper + 4 call sites, three `as unknown as Partial<…>` casts, the `as any` session-create cast, and the `String(id)` linked-user coercion) removed. Defensive `user.blocked?.isBlocked` null-checks retained as belt-and-braces guards against manual Mongo writes. 97 tests green, zero test-file changes.
**Implementer:** Claude / Ashhu pair
**Linked commit:** `chore(models): replace InferSchemaType with explicit interfaces` (local, not yet pushed)

### Original question

Mongoose 8's `InferSchemaType<typeof XYZSchema>` misbehaves in two places we hit in Phase 2:

1. `_id` is not included in the inferred type, so lean reads fail `.lean<T>()` assignments wherever callers touch `row._id`.
2. ObjectId `ref` fields (e.g. `users.referredBy`, `device_fingerprints.linkedUserIds[]`) resolve to a class-metadata shape (`{ prototype?: ObjectId; cacheHexString?: ...; ... }`) instead of `Types.ObjectId`.

Every workaround site in the auth module was tagged `TODO(schema-types)`. The refactor replaced `export type XyzAttrs = InferSchemaType<typeof XyzSchema>;` with hand-written interfaces and removed all `as unknown as Partial<XyzAttrs>` / `String(id)` / `(row as { _id?: unknown })._id` casts added as Phase 2 workarounds.

---

## 16. SES from-domain verification (DKIM + DMARC for cashfb.com)

**Status:** :red_circle: Open
**Blocks:** Prod launch only. Does NOT block dev/staging — the invoice pipeline is env-gated and falls back to `LogOnlyEmailSender` when `SES_FROM_EMAIL` is unset.
**Recommended default:** Verify the `cashfb.com` domain in AWS SES ap-south-1, publish DKIM CNAMEs + SPF + DMARC records at the registrar, and set `SES_FROM_EMAIL=noreply@cashfb.com` in prod.

Without domain verification, SES prod sending is rate-limited to the sandbox quota and all recipients must be pre-verified. Invoice emails wouldn't reach paying users. Gmail and Outlook have been tightening DKIM/DMARC enforcement since 2024 — unsigned invoice mail from a transactional sender risks silent quarantine.

**Action needed:**

1. Confirm the purchased domain (`cashfb.com` or alternative) and the registrar.
2. Verify the domain in SES ap-south-1 via the AWS console. Capture the three DKIM CNAME records SES issues.
3. Add DKIM CNAMEs + an SPF TXT (`v=spf1 include:amazonses.com ~all`) + a starting-point DMARC TXT (`v=DMARC1; p=quarantine; rua=mailto:dmarc@cashfb.com`) at the registrar.
4. Set `SES_FROM_EMAIL` (prod-required via `env.ts` superRefine) and optionally `SES_REPLY_TO_EMAIL` (prod-optional; if unset, the MIME builder omits the Reply-To header per Phase 5 Chunk 1 sign-off).
5. Move the SES account out of sandbox by opening an AWS support ticket with expected send volume + sample invoice content.

Low-effort (one working day including DNS propagation) but must be done before the first prod subscription charges. Tracked here so prod launch can't accidentally ship with invoice email silently dropping.

---

## 17. KYC + TDS gate on prize-winner claim path (Phase 8)

**Status:** :white_check_mark: CLOSED (Phase 8 Chunk 4)

**Implementation shipped:**

- **Gate location:** `src/modules/redeem-codes/redeem-codes.service.ts` → `claim()` method. Runs after advisory pre-checks and before the atomic FCFS flip.
- **Evaluation helper:** `src/shared/services/kyc.service.ts` → `KycService.evaluateGate(userId, now)` returns `{allowed, reason, thresholdPaise, cumulativePaise, kycStatus}`. Service-level pure read; no I/O beyond Mongo. Threshold sourced from `AppConfig.kycThresholdAmount` at request time.
- **Cumulative-FY definition:** sum of `PrizePoolWinner.finalAmount` over the current IST financial year (Apr 1 → Mar 31) where `payoutStatus ∈ {PENDING, RELEASED}`. WITHHELD and VOID excluded.
- **Block response:** `KycRequiredError(451)` with `details: {thresholdPaise, cumulativePaise, kycStatus}`. Error class was forward-declared in Chunk 1 (`src/shared/errors/AppError.ts`); Chunk 4 lights up real callers.
- **TDS computation:** pure function `computeTds194BA(finalAmountPaise)` in `src/shared/services/tds.ts` — flat 30% rounded to integer paise. No threshold, no slab; statutory rate.
- **Transactional flip:** on successful claim with a linked `PrizePoolWinner` row (matched by `(userId, redeemCodeId)`), the Mongo transaction flips `payoutStatus: 'RELEASED'`, writes `tdsDeducted`, `releasedAt`, and `panAtPayout` (from `users.kyc.panLast4`). Claim response surfaces the deduction via `tds: {deductedPaise, appliedOn, winnerId}` OR `tds: null` when no linked winner row exists.
- **No face-value modification** per §8j. Gift-code denomination is unchanged; TDS is absorbed by the company, recorded on the `PrizePoolWinner.tdsDeducted` field for accounting. Quarterly Challan 281 deposit + Form 16A remain ops-level, out of the service.

**Manual KYC verification workflow (MVP):** until a dedicated `/admin/users/:id/kyc-verify` endpoint lands (deferred to Phase 9), ops flip `users.kyc.status` to `VERIFIED` via mongosh after collecting PAN out-of-band. Documented in `ADMIN_OPERATIONS.md` §5.

**Tests:** 11 new specs across `kyc.service.spec.ts`, `tds.spec.ts`, `date.spec.ts` (FY bounds), and `redeem-codes.service.spec.ts` (gate + TDS write + no-linkage path). Suite: 356 → 367 green.

**Closed by:** Phase 8 Chunk 4 commit.

---

## 18. Orphaned `FAILED` webhook_events cron sweep (post-MVP)

**Status:** :red_circle: Open
**Blocks:** Nothing in the MVP critical path. Phase 7 ships event-driven webhook retries only — `WebhookService.dispatchAndFinalise` enqueues a BullMQ retry job on failure. If the enqueue itself fails (Redis down at the exact catch moment), Razorpay's external retry cadence is the fallback.
**Recommended default:** Defer until production data shows whether Razorpay's external retry + our event-driven retry is sufficient to drain `webhook_events` rows that end in `FAILED`. If orphans accumulate, add a Phase 9+ cron scanning `{status: 'FAILED', attempts < 7, receivedAt: {$gte: 24h ago}}` and enqueueing retries.

Two failure modes that could produce orphaned FAILED rows:

1. The enqueueRetry call in `dispatchAndFinalise` throws (Redis down) AND Razorpay doesn't retry externally (e.g. the 24h window expired).
2. A BullMQ retry fails its own enqueue (worker crash between job-attempt failure and backoff schedule) — unlikely given BullMQ's internal Redis-level state machine but not impossible under pathological Redis partition scenarios.

**Action needed:** Monitor `webhook_events.status = 'FAILED'` counts in production for 30 days post-launch. If the stale-orphan count exceeds ~1-2 per week, build the cron sweep. Otherwise continue deferring.

---

## Template for closing an item

When a decision closes, replace its block with:

```
## N. <Title>

**Status:** :green_circle: Closed on YYYY-MM-DD
**Resolution:** <one-paragraph description of the final decision>
**Implementer:** <who rolled it out>
**Linked PR:** #NNN
```

Keep the original wording below under `### Original question` for future reference.
