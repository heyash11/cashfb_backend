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

## Phase 7 — Real-time + jobs polish (1 day)

**Goal:** Socket.IO with Redis adapter working across tasks, Bull Board mounted, all remaining jobs implemented.

**Tasks**

- `src/config/socket.ts` with Redis adapter + auth middleware.
- All socket events from `docs/ARCHITECTURE.md` §7 wired via `@socket.io/redis-emitter` in workers.
- Bull Board at `/admin/queues` (SUPER_ADMIN only + IP allowlist in prod).
- `subscription-expiry-sweep` job (every 15 min).
- `antifraud-scan` job (nightly 02:00 IST).
- `audit-archive` job (weekly): export logs > 90 days to S3 NDJSON, delete from primary.

**Acceptance criteria**

- Broadcast from worker reaches clients connected to api-svc tasks.
- Socket auth rejects missing/invalid JWT.
- Device mismatch on socket handshake rejected.
- Bull Board loads behind RBAC.

---

## Phase 8 — Admin panel APIs (0.5 day)

**Goal:** Every admin surface from `docs/API.md` §4.10 exists and is RBAC-gated with audit logging.

**Tasks**

- Implement all admin endpoints.
- Audit-log middleware on every write: captures `actor`, `action`, `resource`, `before`, `after`, IP, user agent.
- Dashboard metrics endpoint: DAU, MAU, vote count today, pool today, gift-code availability, active rooms, top donor, MTD revenue. Cache in Redis 60s.
- CSV export endpoints stream (use `res.write` chunks, not buffered responses).

**Acceptance criteria**

- Every admin write produces an `audit_logs` row.
- RBAC denies cross-role access (SUPPORT_ADMIN cannot reach PAYMENT_ADMIN endpoints).
- Dashboard returns within 500ms at warm cache.

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
