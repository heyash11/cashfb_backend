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

**Status:** :green_circle: Closed on 2026-04-24 (Phase 9 Chunk 4)
**Resolution:** Added `deletedAt`, `anonymizedAt`, and `erasureHold` to the `users` model (no new fields on other collections). 30-day grace window with admin-pausable hold; daily sweep at 02:10 IST anonymizes expired rows in-place. Full design in [docs/DPDP.md](DPDP.md).

**Sub-question resolutions:**

1. _Does `deletedAt`/`anonymizedAt` belong on `donations`?_ **No.** Donor PII on `donations` (displayName, message, socialLinks, ipAddress, notes) is cleared by the sweep cascade — no new fields on donations. userId preserved so revenue aggregation stays accurate. Same treatment applies to `notifications` (title/body/payload cleared, userId preserved).
2. _Retain `audit_logs` / `coin_transactions` / `prize_pool_winners`?_ **Retain.** Audit-log integrity is a compliance requirement; `coin_transactions` + `prize_pool_winners` fall under §194BA TDS 7-year retention. The panAtPayout on winner rows is already last-4-only so it's not a fresh PII surface. Admin panel renders anonymized actors as `REDACTED_USER` (client-side; row NOT mutated).
3. _30-day grace acceptable?_ **Yes.** Implemented as 30 days, user can cancel during grace, admin can pause and resume.

**Implementer:** Claude (Phase 9 Chunk 4 commit).

### Original question

Retained above this line for future reference.

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

## 19. DLQ integration spec — upgrade to real BullMQ Worker lifecycle

**Status:** :red_circle: Open (low priority). Tracked for Phase 9 Chunk 5 or Phase 10.
**Blocks:** Nothing. Current spec exercises the DLQ queue write against real Redis, but the Worker lifecycle + `failed` event emission is still mocked via a fake Worker object.
**Risk of current state:** A BullMQ version-drift bug in the Worker → `failed` event contract (event name change, argument shape change, listener registration semantics) would not be caught by the current integration spec. The unit spec for `routeFailedToDlq` already covers the listener logic in isolation; the integration spec's job is to catch wiring regressions.

**Upgrade plan:**

1. Enqueue a job with `attempts: 1` into a real BullMQ queue (e.g. a throwaway `test-fail-queue`).
2. Boot a real `Worker` whose processor unconditionally throws.
3. Register `routeFailedToDlq(worker)` on that worker.
4. Wait for the `failed` event to fire (either via promise or `worker.waitUntilReady` + polling the DLQ with a timeout).
5. Assert the DLQ queue has 1 job with the expected shape.
6. `await worker.close()` in afterEach.

**Action needed:** No immediate work. File this ticket against Phase 9 Chunk 5 or Phase 10 observability pass.

---

## 20. User-side HTTP surface not mounted in app.ts

**Status:** :green_circle: Closed on 2026-04-24 (Phase 9 Chunk 5 side-effect)
**Resolution:** All user-side router factories (`createAuthRouter`, `createUsersRouter`, `createVotesRouter`, `createPostsRouter`, `createRedeemCodesRouter`, `createDonationsRouter`, `createSubscriptionsRouter`, `createCustomRoomsRouter`) mounted under `/api/v1/*` in `src/app.ts`. Middleware posture verified: every user route uses `requireUser` (JWT bearer) only — no admin middleware bleed (ipAllowlist / adminSession / csrfCheck / requireAnyRole stay scoped to `/api/v1/admin/*`).

**Discovery context:** Phase 9 Chunk 5 k6 load scripts (`votes-burst`, `fcfs-race`) required authenticated user JWTs issued via the real HTTP surface. The unmounted state blocked those scripts. Rather than defer to a dedicated §20 chunk, scope expanded within Chunk 5 as a contiguous unit of work.

**Test coverage added:** `test/integration/flows/user-http-auth.spec.ts` verifies (a) routes are mounted (not 404), (b) `requireUser` gate returns 401 UNAUTHORIZED on /me/coins, /votes, /posts without a bearer token, (c) admin middleware has NOT bled onto user routes (no 403 ADMIN_IP_NOT_ALLOWED / CSRF_INVALID), (d) admin surface remains gated (401/403 on `/admin/users` without admin-session).

**Implementer:** Claude (Phase 9 Chunk 5 commit).

### Original question

Opened in Phase 9 Chunk 1: `src/app.ts` mounts only the admin surface (`/api/v1/admin/*`) and the public webhooks router. User-facing routes had controller + router factories but were not wired. Risk: Flutter app cannot call any user endpoint; client integration testing blocked.

---

## 21. Healthcheck liveness / readiness split for Phase 10 staging deploy

**Status:** :red_circle: Open (deferred to Phase 10). Raised during Phase 9 Chunk 2 scope discussion on 2026-04-24.

**Current state:** `src/app.ts` exposes a single `GET /health` endpoint that returns `{status: 'ok', ts, uptime, env}` with no downstream dependency check. That single endpoint conflates two concerns: "is the process alive?" (liveness) and "is the process ready to serve traffic?" (readiness).

**Why defer:** The split only matters once we have a container orchestrator that routes traffic based on the distinction — i.e. the ALB + ECS Fargate target-group health check (liveness) vs the task-level readiness probe (readiness). That plumbing lands in Phase 10 deploy. Doing the split now against a dev-only boot produces a no-op distinction.

**Planned shape for Phase 10:**

- `GET /health` — existing; process-alive ping. Used by ALB target-group health check. Always 200 if the Express event loop is responsive.
- `GET /ready` — new; returns 503 while startup tasks (mongoose connect, redis ping, jwt keys loaded) are pending, 200 once the process is wired and ready to serve. Downstream liveness (Mongo `ping`, Redis `PING`) MAY be included but adds cost per-poll — evaluate against ALB polling frequency before deciding.
- `src/shared/readiness.ts` — `setReady()` called from `server.ts` after `mongoose.connect` + `initJwtKeys` + redis `subscribe` complete. `/ready` reads this flag.

**Action needed:** Revisit during Phase 10 deploy chunk. No work in Phase 9.

---

## 22. `/metrics` route label shows `"/"` instead of `"/metrics"` for self-scrapes

**Status:** :red_circle: Open (minor). Raised during Phase 9 Chunk 3 smoke-testing on 2026-04-24.

**Symptom:** Every Prometheus scrape of `GET /metrics` registers in the `http_request_duration_seconds` / `http_requests_total` series under `route="/"` rather than `route="/metrics"`. Makes the self-observability signal ambiguous with any future handler mounted at the root.

**Cause:** `/metrics` is mounted as `app.use('/metrics', createMetricsRouter())` where the router is `router.get('/', ...)`. Express populates `req.route.path` with the router-relative path (`"/"`), not the full mount path. The http metrics middleware reads `req.route?.path` directly, so it sees `"/"`.

**Fix options:**

1. Update [src/shared/metrics/http.ts](../src/shared/metrics/http.ts) to use `req.baseUrl + (req.route?.path ?? '')` — preserves the existing mount pattern, renders `/metrics` + `/`. Normalise trailing-slash if it's cosmetic (`"/metrics/"` vs `"/metrics"`).
2. Mount `/metrics` as a direct handler — `app.get('/metrics', ipAllowlist(), handler)` — instead of a nested Router. Simpler but loses the Router's ability to host future `/metrics/*` sub-routes.

**Priority:** Dashboard quirk, not a correctness issue. Track for Phase 9 Chunk 5 or Phase 10 cleanup pass. Do NOT block DPDP (Chunk 4) on this.

---

## 23. Local dev Node version mismatch (Node 20.19 vs engines-required 22)

**Status:** :red_circle: Open. Raised during Phase 9 Chunk 3 smoke-testing on 2026-04-24.

**Symptom:** On a dev host running Node 20.19, `pnpm dev` (which resolves to `tsx watch --env-file-if-exists=.env --import ./src/instrument.ts src/server.ts`) silently stalls — the tsx parent process spawns but never boots the child server, logs stay at the banner, `/health` is unreachable. Same behaviour for `node --import=tsx --import ./src/instrument.ts src/server.ts`.

**Workaround proven during Chunk 3 smoke:** drop `--import ./src/instrument.ts` for local boot (`npx tsx src/server.ts`). Sentry is not wired in local dev anyway because `SENTRY_DSN` is absent — so skipping `instrument.ts` changes nothing observable locally. Metrics, error middleware, and process handlers all behave identically.

**Cause:** Node 20's tsx loader preload ordering does not reliably hand off `--import <.ts-path>` to the loader.mjs hook. `package.json` engines field is `>=22.0.0 <23.0.0` — the configuration assumes Node 22, which is what the Docker image uses.

**Fix:** `nvm install 22 && nvm alias default 22` on the dev host. Verify with `node --version` → `v22.x`. `pnpm dev` works end-to-end on Node 22.

**Priority:** Local dev quality-of-life only. Does NOT affect production (Dockerfile base is `node:22-alpine` for the builder and `distroless/nodejs22-debian12` for runtime). Does NOT affect CI (`actions/setup-node` pins to 22 in [.github/workflows/ci.yml](../.github/workflows/ci.yml)).

---

## 24. Encryptor singleton pattern + test coverage

**Status:** :red_circle: Open (tracker — partial fix shipped). Raised during Phase 9 Chunk 5 load-test smoke on 2026-04-24.

**Finding:** A class of bugs where sibling admin + user services each instantiated separate `InMemoryEncryptor()` instances via their own `defaultEncryptor()` function. Same process, two different ephemeral KEKs → data encrypted by the admin path could not be decrypted by the user path. Caught during the fcfs-race k6 smoke — the 1 winning claim out of 100 contended for a redeem-code returned a 500 instead of a 200 because `RedeemCodeService.claim` couldn't decrypt the ciphertext that `AdminRedeemCodeService.uploadBatch` had just written.

**Fix shipped in Chunk 5:**

- New `src/shared/encryption/default.ts` → `getDefaultEncryptor()` returns a module-level singleton (keeps `KmsEncryptor` in prod, `InMemoryEncryptor` in dev). Production KMS was unaffected (stateless client, shared by key id), but the singleton is cleaner regardless.
- `RedeemCodeService` + `AdminRedeemCodeService` migrated (fcfs-race regression).
- `CustomRoomsService` + `AdminCustomRoomsService` migrated preemptively — same bug pattern, different ciphertext surface (BGMI room credentials). No load test exercises this path today, but leaving half of a uniform bug class would invite regression.

**Still open (tracked here):**

1. **Integration test coverage** — add a spec under `test/integration/flows/` that deliberately exercises a write-via-admin → read-via-user encryption roundtrip for BOTH redeem-codes and custom-rooms. Purpose: make any future reintroduction of per-service encryptor instantiation fail in CI. The existing fcfs-race k6 smoke happens to catch redeem-codes, but k6 runs aren't in CI — only the Vitest integration suite is (`.github/workflows/ci.yml` §integration).
2. **Lint / CI grep guard** — block direct `new InMemoryEncryptor()` / `new KmsEncryptor()` calls outside `src/shared/encryption/default.ts` and test files. Options: ESLint `no-restricted-syntax` rule, or a CI grep step in `ci.yml`.
3. **PAN encryption audit** — `users.kyc.pan[Ct|Iv|Tag|DekEnc]` ciphertext is stored by admin-KYC flows and read by user-facing paths. The admin panel handler instantiation chain should be audited to confirm it resolves through `getDefaultEncryptor()` end-to-end. If there's a separate admin-kyc service that instantiates its own encryptor, it has the same bug class as redeem-codes/custom-rooms had.

**Priority:** Medium. The in-production path (KMS) is safe — this is about preventing regression in dev and catching dev-only bugs before they reach prod contention patterns. Phase 10 or later.

**Implementer (partial fix):** Claude (Phase 9 Chunk 5 commit 01e7981).

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
