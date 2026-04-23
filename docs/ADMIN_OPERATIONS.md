# Admin Operations Runbook

Runbook for operators interacting with the admin surface (Phase 8). Every endpoint referenced here is wired in `src/app.ts` under `/api/v1/admin/*` and gated by the chain `ipAllowlist → adminSession → csrfCheck → requireAnyRole → auditLog`. The canonical route catalogue lives in `postman/CashFB-Admin.postman_collection.json` (57 requests).

---

## §Setup

**First-time bootstrap (fresh environment):**

```bash
# 1. Start infra + API + worker
docker compose -f docker-compose.dev.yml up -d
pnpm dev            # port 4000
pnpm dev:worker     # separate terminal

# 2. Create the first SUPER_ADMIN (interactive password prompt)
pnpm admin:create -- --email=admin@cashfb.com
```

**KYC threshold migration (existing environments).** The `AppConfig.kycThresholdAmount` schema default was changed from 10,000 paise (₹100) to 1,000,000 paise (₹10,000) in Phase 8 §KYC. The schema default only applies to fresh installs — existing `app_configs` docs keep their old value. Run once per environment:

```js
db.app_configs.updateOne({}, { $set: { kycThresholdAmount: 1000000 } });
```

Or via the admin API once you have a SUPER_ADMIN session: `PATCH /api/v1/admin/app-config { "kycThresholdAmount": 1000000 }`.

**Postman.** Import both files from `postman/` + set the active environment. The Login request's test script populates `csrfToken`; every subsequent POST/PATCH/PUT/DELETE auto-injects `X-CSRF-Token` via the collection-level pre-request script.

---

## §1 Authentication

**Login.** `POST /api/v1/admin/auth/login` with `{email, password}` → response sets two cookies (`cfb_admin_session` HttpOnly, `cfb_admin_csrf` readable) and returns `{csrfToken, admin, absoluteExpiresAt}`. Cookies expire 4 h after login (absolute TTL); the session rolls forward every 30 min of activity (idle TTL).

**CSRF.** Every write (POST/PATCH/PUT/DELETE) requires a triple-match: `X-CSRF-Token` header == `cfb_admin_csrf` cookie == the session's stored token. Rotate via `POST /auth/csrf-rotate` if you suspect compromise.

**Logout.** `POST /auth/logout` destroys the session server-side. `DELETE /admins/:id` destroys ALL sessions for a specific admin (see §6).

---

## §2 Content workflows

**Posts.** Daily trivia rotation.

```bash
# Create
curl -X POST $BASE/api/v1/admin/posts \
  -b cookies.txt -H "X-CSRF-Token: $CSRF" -H "Content-Type: application/json" \
  -d '{"title":"Daily","dayKey":"2026-04-25","scheduledAt":"2026-04-25T10:00:00Z","tierRequired":"PUBLIC"}'

# Promote to LIVE (or CLOSED at end-of-day)
curl -X PATCH $BASE/api/v1/admin/posts/$POST_ID \
  -b cookies.txt -H "X-CSRF-Token: $CSRF" -H "Content-Type: application/json" \
  -d '{"status":"LIVE"}'
```

Role: `CONTENT_ADMIN` or `SUPER_ADMIN`.

**Redeem codes.** Upload CSV of Google Play codes, publish a batch to a post, users FCFS-claim.

CSV format (no quotes, header required):

```
code,denomination
GCODE-AAAA-1111,5000
GCODE-BBBB-2222,5000
```

```bash
# Upload (multipart — Postman prompts for file path)
curl -X POST $BASE/api/v1/admin/redeem-codes/upload \
  -b cookies.txt -H "X-CSRF-Token: $CSRF" \
  -F "supplierName=Xoxoday" -F "denomination=5000" -F "file=@codes.csv"

# Publish N codes from a batch to a post
curl -X POST $BASE/api/v1/admin/redeem-codes/publish \
  -b cookies.txt -H "X-CSRF-Token: $CSRF" -H "Content-Type: application/json" \
  -d '{"batchId":"...","postId":"...","count":100}'
```

Typical failure: `VALIDATION_FAILED` when CSV rows don't match the denomination param, or `DUPLICATE_IN_DB` when the same code hash already exists in an earlier batch.

**CMS.** Five keyed entries (`TERMS`, `HOW_DISTRIBUTE`, `FAQ`, `PRIVACY`, `GRIEVANCE`). `PUT /cms/:key` upserts + bumps `version`; clients should cache-bust on version change.

**Sponsors.** Home-feed banner management. Slots 1–3; `status: ACTIVE | PAUSED | EXPIRED`; higher `priority` wins ties within a slot.

**Custom rooms.** BGMI/FF tournaments. State machine: `SCHEDULED → LIVE → COMPLETED`. `POST /:id/credentials` encrypts room credentials via KMS envelope; `POST /:id/winners` is `PAYMENT_ADMIN` only (prize assignment is a financial action).

---

## §3 Payment workflows

**Donations.** `GET /donations` to list, `POST /:id/feature` to flag a donation for the home-feed top-donor surface.

**Subscriptions.** `GET /subscriptions` for tier/status filter; `GET /subscriptions/revenue?from=&to=` for aggregate revenue. Refund deductions are reported separately under `/refunds`.

**Refunds.** `POST /refunds {paymentId, reason}` — triggers two sequential Razorpay API calls (refund + subscription cancel). `PAYMENT_ADMIN` or `SUPER_ADMIN` only. The local state update happens on receipt of the `refund.processed` webhook, not synchronously.

**Prize pools.** `GET /prize-pools` lists daily rows; `POST /run` is the manual re-trigger (SUPER_ADMIN only, for missed crons); `GET /prize-pools/winners?dayKey=` lists payout ledger for a day; `POST /prize-pools/winners/:id/mark-payout` flips PENDING → RELEASED/WITHHELD/VOID with optional `challanNo` + `panLast4`.

---

## §4 User workflows

**Search + inspect.** `GET /users?search=9999` — narrow phone-prefix + exact-email match.

**Block / unblock.** `POST /users/:id/block {reason: "..."}` — reason required (min 10 chars). Same for `/unblock`. Blocked users 401 on auth + claim paths; existing access tokens stay valid until their 15-min JWT expiry (user-facing consumer tokens don't check the admin session denylist).

**Coin adjust.** `POST /users/:id/coins {delta: 100, reason: "..."}`. Transactional: `User.coinBalance $inc` + `coin_transactions` insert atomic. Reason required, min 10 chars. Delta signed: positive credits, negative debits. Debits that would overdraft the balance below zero fail with 400 `VALIDATION_FAILED`.

**Force-logout.** `POST /users/:id/force-logout` — writes the Redis cutoff that invalidates every access + refresh token issued before the cutoff. Per-user, not per-JTI. TTL 30 days matching the refresh-token max lifetime.

---

## §5 Compliance workflows (KYC + TDS)

### KYC gate decision tree

A user calling `POST /redeem-codes/:id/copy` hits the gate:

```
User claims prize:
├── Cumulative FY prize value ≤ AppConfig.kycThresholdAmount
│   └── ALLOW — no KYC needed
└── Cumulative FY prize value > AppConfig.kycThresholdAmount
    ├── user.kyc.status === 'VERIFIED'
    │   └── ALLOW + compute TDS @ 30% + flip linked PrizePoolWinner
    │       to RELEASED with tdsDeducted, releasedAt, panAtPayout
    └── user.kyc.status !== 'VERIFIED'
        └── REJECT with 451 KYC_REQUIRED + details {
              thresholdPaise, cumulativePaise, kycStatus
            }
```

"Cumulative FY prize value" = sum of `PrizePoolWinner.finalAmount` in the current Indian FY (Apr 1 → Mar 31 IST) where `payoutStatus ∈ {PENDING, RELEASED}`. WITHHELD + VOID excluded.

### TDS policy

`tdsDeducted = round(finalAmount × 0.30)` per §194BA. Stored on `PrizePoolWinner.tdsDeducted`. **No face-value modification** — the gift-code denomination is unchanged, TDS is a company liability recorded on the winner row for accounting. Quarterly: deposit via Challan 281, record `tdsChallanNo`, generate Form 16A (Form 26Q filing) — ops process, not wired into the app.

### Manual KYC verification workflow (MVP)

Until a self-service `/admin/users/:id/kyc-verify` endpoint lands (deferred to Phase 9), ops flip the status via mongosh after collecting PAN out-of-band:

```js
db.users.updateOne(
  { _id: ObjectId('<userId>') },
  {
    $set: {
      'kyc.status': 'VERIFIED',
      'kyc.panLast4': '1234',
      'kyc.verifiedAt': new Date(),
    },
  },
);
```

Ops may also store the envelope-encrypted full PAN (`panCt`, `panIv`, `panTag`, `panDekEnc`) for audit retention. The last-4 is what `panAtPayout` pulls at claim time.

### Audit log reading

`GET /audit-logs` — SUPER_ADMIN only. Exact-match filters: `actorId`, `resourceKind`, `resourceId`, `action`, `from`, `to`. Keyset pagination via `cursor` (base64 of `createdAt_millis_id`). Reading audit logs is NOT itself audited — prevents a feedback loop where the reader generates the row the next read fetches.

---

## §6 Platform admin

**Admins CRUD.** `POST /admins {email, password, name, role}` mints a new admin via the same bootstrap helper as the CLI. Response redacts `passwordHash` + `twoFactor.secret`. `DELETE /admins/:id {reason}` is **soft** — sets `disabled: true` AND calls `AdminSessionStore.destroyAllForAdmin` so the deactivated admin's open tabs 401 on next request. Hard delete is forbidden (would orphan `audit_logs.actorId` references).

**Ads config.** `PUT /ads-config/:placementKey` upserts a placement (BANNER/INTERSTITIAL/REWARDED_VIDEO/NATIVE; ADMOB/UNITY/APPLOVIN/IRONSOURCE). SUPER_ADMIN only — a misconfigured placement kills ad revenue.

**App config.** `PATCH /app-config { ...fields }` is field-level `$set`; unsupplied fields untouched. Strict Zod schema rejects unknown keys with 400. High-signal fields:

- `maintenanceMode: boolean` — short-circuit client → "We'll be back shortly"
- `kycThresholdAmount: number` — paise threshold for the KYC gate
- `featureFlags.tournaments`, `featureFlags.proContestAccess` — PROGA 2025 gates (default false; legal sign-off required before flipping true)
- `adminIpAllowlist: string[]` — tenant-wide IP floor; empty = permissive

**DLQ inspection + requeue.** `GET /dlq?includeRequeued=false` lists BullMQ DLQ entries hidden by the sidecar `dlq_audit` collection once requeued. `POST /dlq/:jobId/requeue {reason}` preserves the DLQ entry (forensic trail) and enqueues a fresh job to the source queue. Double-requeue rejected by the sidecar's unique index on `originalJobId`.

---

## §7 Observability

**Dashboard.** `GET /dashboard/metrics` — 60 s Redis cache. Response includes `generatedAt` + `cached` so the UI can display "Data as of X" without a second request. Any admin role (SUPPORT/PAYMENT/CONTENT/SUPER) can read.

**Server logs.** Pino JSON to stdout. Pipe through `pnpm dev 2>&1 | pino-pretty` in dev for readable output. Sensitive fields (passwordHash, codeCt, etc.) are pre-redacted by the logger config — same list as the audit middleware's redactor (`src/shared/utils/redact.ts`).

**Audit trail.** Every admin write creates a row in `audit_logs` with `{actorId, actorEmail, action, resource: {kind, id}, before, after, ip, userAgent}`. Sensitive fields on `before`/`after` are redacted in BOTH the persisted row AND the HTTP response body. Reading is via `GET /audit-logs` (SUPER_ADMIN only).

---

## §8 Smoke test commands (reference)

After any dev-infra change or mongo restart, run these in sequence to prove the chain is alive end-to-end:

```bash
BASE=http://localhost:4000

# 1. Health
curl -s $BASE/health

# 2. Login + capture cookies
curl -s -X POST $BASE/api/v1/admin/auth/login \
  -H "Content-Type: application/json" \
  -c /tmp/ck.txt \
  -d '{"email":"admin@cashfb.test","password":"..."}'
CSRF=$(grep cfb_admin_csrf /tmp/ck.txt | awk '{print $7}')

# 3. Dashboard (cache miss first, cache hit second)
curl -s $BASE/api/v1/admin/dashboard/metrics -b /tmp/ck.txt

# 4. Audit logs (SUPER only)
curl -s "$BASE/api/v1/admin/audit-logs?limit=5" -b /tmp/ck.txt

# 5. App config
curl -s $BASE/api/v1/admin/app-config -b /tmp/ck.txt
```
