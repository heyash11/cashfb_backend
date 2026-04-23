# BUILD_PLAN.md

Strict phase-by-phase execution order. Each phase ships green on `pnpm test && pnpm lint && pnpm typecheck` before moving on. Do not skip ahead.

---

## Phase 0 — Scaffolding (0.5 day)

**Goal:** A bare Express server boots, talks to a local Mongo + Redis, and responds on `/health`.

**Tasks**

- `pnpm init`, install all deps from `CLAUDE.md` §2.
- `tsconfig.json`: strict, ESM, target ES2022, `moduleResolution: Bundler`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`.
- ESLint flat config + Prettier. Husky pre-commit runs typecheck + lint-staged.
- Vitest config with coverage.
- `Dockerfile` multi-stage, distroless final image, non-root user.
- `docker-compose.dev.yml` with Mongo replset (`mongo:7 --replSet rs0`) and Redis 7.
- `src/config/env.ts`: Zod schema over `process.env`. Exits 1 on missing required vars.
- `src/config/logger.ts`: pino with redaction.
- `src/server.ts`: bare Express boot. Mount `/health` returning 200.
- `pnpm dev` works against compose.

**Acceptance criteria**

- `curl localhost:4000/health` returns `{"status":"ok","ts":...}`.
- `pnpm typecheck` passes with zero errors.
- `pnpm lint` passes with zero warnings.
- `pnpm test` runs and reports (even if just a smoke test).
- `docker compose -f docker-compose.dev.yml up -d` brings up a working Mongo replset and Redis.

---

## Phase 1 — Data layer (1.5 day)

**Goal:** All 27 Mongoose models exist with indexes, repositories return lean objects, KMS envelope helpers work.

**Tasks**

- Build all models listed in `docs/DATA_MODEL.md` in `src/shared/models/`. One file per model. Filename: `User.model.ts`.
- `timestamps: true`, `versionKey: false`, `toJSON` transform to strip `_id` and `__v`.
- Apply every index listed in `docs/DATA_MODEL.md`.
- Repository layer per module. Reads use `.lean()` unless mutation. Writes return hydrated docs.
- `src/config/db.ts`: `mongoose.connect` with `retryWrites: true`, `readPreference: 'primaryPreferred'`.
- `src/shared/encryption/envelope.ts`: KMS envelope helpers. Unit-tested with a mocked KMS.
- `scripts/seed.ts`: creates `app_config` doc with defaults + one SUPER_ADMIN user.

**Acceptance criteria**

- All 27 models importable.
- All unique + compound indexes present (verified by an integration test that checks `db.collection.getIndexes()`).
- `pnpm seed` creates `app_config` and admin user idempotently.
- Encryption round-trip test passes: `encrypt(x)` then `decrypt()` returns `x`.

---

## Phase 2 — Auth (1.5 days)

**Goal:** Users can sign up with phone OTP, log in, refresh, log out. JWTs are RS256. Device binding works. Reuse detection works.

**Tasks**

- `OtpService`: send via MSG91 (DLT template), fallback to Twilio. Hash OTP before store with per-record salt. TTL 5 min. Max 5 attempts.
- `auth.service.ts`: signup (DOB 18+ gate), login, refresh, logout.
- JWT access: RS256, 15 min. JWT refresh: 30 day, rotating, family-tracked via `login_sessions`.
- Reuse detection: if a refresh token in a revoked family is presented, revoke the whole family.
- `auth.middleware.ts`: verify access token, attach `req.user`.
- `rbac.middleware.ts`: check role against required role.
- Rate limits per `docs/API.md` §4.1.
- Integration tests: signup happy path, login, refresh rotation, reuse detection, device mismatch rejection, expired token rejection.

**Acceptance criteria**

- Phone number signup with valid OTP creates user, credits 3 coins atomically, returns JWT pair.
- Refresh rotation: old refresh token invalidated on use.
- Presenting a used refresh token revokes all sessions in that family.
- Different `deviceId` on refresh is rejected.
- `coin_transactions` has a `SIGNUP_BONUS` row and `users.signupBonusGranted` is `true`.
- All 7 integration tests pass.

---

## Phase 3 — Coins, posts, votes (1 day)

**Goal:** Atomic coin economy. One vote per user per day enforced at the database.

**Tasks**

- Posts CRUD for admin (`POST /admin/posts`, `GET /admin/posts`, `PATCH /admin/posts/:id`, `DELETE /admin/posts/:id`).
- `GET /posts?date=YYYY-MM-DD` for users. Returns posts with per-user completion flag.
- `POST /posts/:id/complete`: Mongo transaction. Insert `post_completions` (unique on `{userId, postId}` ensures idempotency), `$inc users.coinBalance: +1`, insert `coin_transactions`. Emit `coins.updated` socket event.
- `POST /votes`: Mongo transaction. Check balance at least 3, insert `votes` (unique on `{userId, dayKey}` blocks double-voting at DB level), `$inc users.coinBalance: -3`, insert `coin_transactions`. Emit `coins.updated`.
- `GET /me/coins?cursor=...` paginated.
- Concurrency tests: two parallel post-complete calls for the same post+user result in exactly 1 coin awarded. Two parallel vote calls result in exactly 1 vote and 3 coins spent.

**Acceptance criteria**

- A user completing 5 posts gains 5 coins. Balance is correct, 5 `coin_transactions` rows exist.
- A user voting twice in one day: second call returns `VOTE_ALREADY_CAST` 409.
- A user with 2 coins trying to vote: returns `INSUFFICIENT_COINS` 402. Balance unchanged.
- Concurrency tests pass.

---

## Phase 4 — Redeem codes (1 day)

**Goal:** Admin uploads CSV of gift codes, they are encrypted, published per post, and distributed FCFS.

**Tasks**

- `POST /admin/redeem-codes/batches`: multipart CSV (`code,denomination`). Validate rows, dedupe via `HMAC-SHA256(code)` hash, encrypt each via envelope helper, bulk insert as `redeem_codes` linked to a new `redeem_code_batches` row. Return per-row errors.
- `POST /admin/redeem-codes/publish`: flip N codes from `AVAILABLE` to `PUBLISHED` against a given post. Emit `redeem.batch.published` socket event.
- `GET /posts/:id/redeem-codes`: require `post_completions` exists for this user+post. Return codes (masked until user taps copy).
- `POST /redeem-codes/:id/copy`: atomic `findOneAndUpdate({_id, status: 'PUBLISHED'}, {$set: {status: 'COPIED', firstCopiedBy, firstCopiedAt}})`. On win, decrypt and return code. On lose, 409.
- Supplier invoice upload field on `redeem_code_batches`.
- `redeem-code-reconcile` cron (hourly): flip `COPIED > 24h` to `CLAIMED`.
- Admin audit CSV export: every code's lifecycle.

**Acceptance criteria**

- Uploading 500 codes creates one batch and 500 encrypted code rows. Duplicates within the file skipped.
- Gating: user who has not completed the post cannot fetch codes.
- Race test: 100 parallel copy attempts on the same code result in exactly 1 success and 99 x 409.
- Decrypted code matches the original plaintext.

---

## Phase 5 — Razorpay (1.5 days)

**Goal:** Donations and subscriptions work end-to-end with webhook-driven state, GST invoices generated on charge.

**Tasks**

- `scripts/migrate-razorpay-plans.ts`: creates Pro and Pro Max plans once. Save plan IDs to `app_config` (not env, so admin can update).
- Donations: `POST /donations/create-order`, then `POST /donations/verify` (tentative), then webhook (authoritative).
- Subscriptions: `GET /subscriptions/plans`, `POST /subscriptions/create`, `POST /subscriptions/verify`, `POST /subscriptions/cancel`, `GET /subscriptions/mine`, `GET /subscriptions/:id/invoices`.
- Webhook handler at `POST /webhooks/razorpay`:
  - Raw body via `express.raw` mounted BEFORE `express.json`.
  - HMAC-SHA256 verify.
  - Dedupe via `webhook_events.eventId` upsert.
  - Switch on event type. Idempotent service methods.
- GST invoice generator on `subscription.charged`:
  - Derive base and GST (`base = round(total * 100 / 118); gst = total - base`).
  - Place of supply = user's declared state. Intra-state uses CGST+SGST. Inter-state uses IGST.
  - Sequential invoice number per FY via a `counters` collection with `$inc`.
  - Render PDF via `pdf-lib`. Upload to S3. Email via SES.
- Refund endpoint + handler.

**Acceptance criteria**

- Donation: order created, checkout, webhook fires, donation status `CAPTURED`, top-donor cache refresh job enqueued.
- Subscription: `create` returns Razorpay sub ID, webhook `subscription.authenticated`, `subscription.charged`, user tier upgrades, `tierExpiresAt` set, invoice PDF uploaded and emailed.
- Duplicate webhook (same `X-Razorpay-Event-Id`) returns 200 without re-processing.
- Invalid signature returns 400 and no state change.
- GST breakdown is correct for intra-state and inter-state cases.

---

## Phase 6 — Custom rooms, prize pool, top donors (1 day)

**Goal:** Admin creates matches with encrypted credentials, they reveal on schedule, results publish after match, daily pool job runs.

**Tasks**

- Custom-room admin CRUD with KMS envelope for room ID + password.
- `GET /custom-rooms?game=&page=`: decrypt credentials only if `now >= visibleFromAt` and user's tier is allowed.
- Result upload: admin endpoint accepts 5 images via S3 presigned PUT. Writes `custom_room_results`.
- Winner assignment: admin endpoint creates `prize_pool_winners` rows with multiplier applied.
- `daily-prize-pool` cron (midnight IST).
- `top-donor-cache` cron (every 5 min). Aggregates `donations` by user, upserts `top_donor_rankings`, emits `top-donor.changed` if rank 1 changed.

**Acceptance criteria**

- Room credentials are encrypted at rest. Decrypted only through `decryptField`.
- Users below `visibleFromAt` see locked fields. Users at or after see decrypted.
- Prize pool cron writes exactly one `prize_pools` row per day. Re-runs are no-ops.
- Top-donor cache refresh is idempotent.

---

## Phase 7 — BullMQ infrastructure + cron primitives (1 day)

**Scope change (2026-04-23):** Phase 7 was originally "Real-time + jobs polish" bundling Socket.IO with BullMQ. Per Phase 7 sign-off, split into:

- **Phase 7 (this entry)** — BullMQ infrastructure, 4 cron primitives, 2 event-driven workers, DLQ routing, Bull-board dashboard.
- **Phase 7.5 (new)** — Socket.IO real-time layer.
- `antifraud-scan` and `audit-archive` deferred to Phase 8+.

**Goal:** Scheduled + event-driven jobs running under BullMQ with Redis, with operational visibility via Bull-board.

**Tasks**

- `src/config/queues.ts` — parse `REDIS_URL` into BullMQ `ConnectionOptions`, lazy `getQueue(name)` registry, `makeWorker` factory, graceful `closeAllQueues`.
- `src/workers/_registry.ts` — symbolic queue + job name + cron schedule constants.
- `src/workers/shutdown.ts` — SIGTERM/SIGINT handlers, per-worker graceful close.
- `src/worker.ts` — top-level entry process. Monolithic worker per product decision (single Node process, all Worker instances).
- 4 cron primitives (all Asia/Kolkata tz):
  - `prize-pool-daily` at `5 0 * * *` → `PrizePoolService.computeAndPublishPool`.
  - `reconcile-codes-hourly` at `0 * * * *` → `reconcileCopiedCodes({cutoffMs: 24h})`.
  - `top-donor-refresh` at `*/5 * * * *` → `DonationService.refreshTopDonorRanking`.
  - `tier-expiry-sweep` at `0 2 * * *` → `sweepExpiredTiers` with self-re-enqueue on batch saturation.
- 2 event-driven queues:
  - `invoice` — `SubscriptionService.onCharged` enqueues `enqueueInvoice({paymentId})` after the transaction commits; worker runs the real `InvoiceService` (PDF + S3 + SES). Handler is idempotent via BullMQ `jobId: invoice-<paymentId>` dedup + domain-level short-circuit when payment already has `invoiceNumber`.
  - `webhook-retry` — `WebhookService.dispatchAndFinalise` catch branch enqueues `enqueueWebhookRetry({eventId, attempt})`. Worker uses a custom backoff strategy matching Razorpay's cadence (`[5s, 30s, 5m, 30m, 2h, 6h, 24h]`) over 7 attempts.
- DLQ routing (`src/workers/dlq.ts`): `failed` listener on each Worker copies exhausted jobs (where `attemptsMade >= attempts`) into a dedicated `dlq` queue. No worker consumes the DLQ — it's a durable inspection surface. Indefinite retention in Phase 7; Phase 8 adds a requeue action + TTL.
- Bull-board mounted at `env.BULL_DASHBOARD_PATH` (default `/admin/queues`) with a placeholder JWT + `role: 'SUPER_ADMIN'` guard. Phase 8 replaces with the full admin middleware stack (IP allowlist + audit-log + per-action RBAC).

**Acceptance criteria**

- Repeatable schedulers registered idempotently (boot replay-safe via `upsertJobScheduler`).
- Handlers accept POJO data (no BullMQ `Job` type coupling); clock injection via `scheduledFor` ISO string.
- Worker process survives SIGTERM with no in-flight job loss.
- Failed jobs beyond retry budget appear in DLQ with full context (original queue, jobId, data, failedReason, stackTrace, attemptsMade, failedAt).
- Bull-board loads behind the placeholder guard and lists every registered queue including DLQ.

---

## Phase 7.5 — Socket.IO real-time layer (0.5-1 day)

**Goal:** Socket.IO with Redis adapter working across api-svc tasks, auth middleware, device-mismatch handshake rejection, worker broadcast via `@socket.io/redis-emitter`.

**Tasks**

- `src/config/socket.ts` — Socket.IO server + `@socket.io/redis-adapter` for cross-task broadcast.
- JWT auth middleware on the socket handshake (reuse Phase 2 `verifyAccessToken`).
- Device-fingerprint check on handshake — reject on mismatch with the user's active session.
- Worker-side broadcast helper (`@socket.io/redis-emitter`) for events emitted from the worker process (e.g. `top-donor.changed` from the Phase 7 cron, `pool.published` from the daily pool job).
- Event table + payload shapes per `docs/ARCHITECTURE.md` §7.

**Acceptance criteria**

- Broadcast from a worker process reaches clients connected to any api-svc task.
- Socket auth rejects missing/invalid/expired JWT.
- Device mismatch on handshake rejected with a clear error code.
- Cross-task delivery verified with two api-svc instances (can be a local docker-compose test).

---

## Phase 8 — Admin panel APIs — ✅ COMPLETE

Delivered across four chunks + three latent-bug fixes + one dev-infra fix + one audit-redaction correction. 57 admin endpoints behind the `ipAllowlist → adminSession → csrfCheck → requireAnyRole → auditLog` chain. 367 tests pass against a single-node MongoMemoryReplSet.

**Chunk decomposition (as built):**

| Chunk   | Delivered                                                                                                                                         | Commit        |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| 1       | admin auth infra (Redis sessions, CSRF triple-match, IP allowlist, RBAC, audit wrapper) + bootstrap CLI                                           | `d8532ef`     |
| 1-fix-a | `mongoose.connect` on api boot                                                                                                                    | `86f20dc`     |
| 1-fix-b | global `AppError → JSON` error handler                                                                                                            | `aff6c6f`     |
| 1-fix-c | wire csrfCheck on POST /logout + /csrf-rotate                                                                                                     | `c78612b`     |
| 2       | HTTP mounts for 6 pre-existing admin services (posts, redeem-codes, donations, subscriptions, custom-rooms, refunds)                              | `ec5da79`     |
| 3a      | admin-users (block, coin-adjust, force-logout with Redis cutoff) + admin-prize-pools + admin-dashboard (cached) + admin-dlq (sidecar Mongo audit) | `1f50444`     |
| 3a-fix  | docker compose on :27018/6380 to sidestep brew mongod, enabled transactions                                                                       | `19fc112`     |
| 3b      | admin-cms, admin-ads-config, admin-sponsors, admin-notifications, admin-audit-logs, admin-admin-users, admin-app-config                           | `4c2ddfe`     |
| 3b-fix  | redact sensitive fields in HTTP response (not just persisted audit row)                                                                           | `edf89e8`     |
| 4       | KYC + TDS claim gate, postman collection (57 requests), docs                                                                                      | (this commit) |

**Goal met.** Every admin surface from `docs/API.md` §4.10 exists and is RBAC-gated with audit logging. Audit-log middleware captures `actor`, `action`, `resource`, `before`, `after`, IP, user agent — AND applies `redactSensitive` to both persisted row and HTTP response body. Dashboard metrics endpoint is Redis-cached 60 s with `generatedAt` + `cached` surfaced. CSV exports stream via `res.write` chunks (redeem-code audit export).

**Phase 8 §KYC + TDS (Chunk 4):** `POST /redeem-codes/:id/copy` runs a three-part gate on the service side — advisory pre-checks, `KycService.evaluateGate`, then a Mongo transaction that atomically flips the FCFS code + writes TDS onto the linked `PrizePoolWinner` row. Threshold via `AppConfig.kycThresholdAmount` (default 1,000,000 paise = ₹10,000). Closes `OPEN_DECISIONS.md` #6 + #17.

---

## Phase 9 — Security, observability, deploy (1 day)

**Goal:** Production-ready on AWS Mumbai.

**Tasks**

- Geo-block middleware reading `app_config.blockedStates` (cached 60s).
- Sentry init via `--import instrument.js`. Release tagging in CI.
- CloudWatch alarm definitions documented in `docs/DEPLOYMENT.md` runbook.
- GitHub Actions CI: typecheck, lint, test, build, push to ECR.
- GitHub Actions deploy: OIDC, ECR, ECS update with circuit breaker + auto-rollback.
- Graceful shutdown: trap SIGTERM, `io.close()`, `server.close()`, BullMQ worker close. Stop timeout 120s.
- `.aws/task-def.json` with health check, log config, secrets references.

**Acceptance criteria**

- Deploying a broken build triggers rollback automatically.
- SIGTERM drains connections within 120s without dropping in-flight requests.
- Sentry receives a test error on staging.
- Geo-block returns 451 for a user with a blocked declared state.

---

## Definition of Done (every phase)

1. Code written, tests written, all green.
2. Types strict, no `any`.
3. No new ESLint warnings.
4. Indexes applied if schema changed.
5. `docs/` updated if public contract changed (API, schemas, events).
6. Conventional commit + PR title.
7. Deployed to staging and smoke-tested.
