# Load tests (k6)

Phase 9 Chunk 5. Four k6 scripts exercising the hot paths + two helper scripts to seed / clean state.

## Install k6

k6 is a Go binary, not an npm package. Not a dev dependency of this repo.

```bash
# macOS
brew install k6

# Linux (Debian / Ubuntu)
sudo gpg -k
sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg \
    --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" | \
    sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update && sudo apt-get install k6

# Verify
k6 version
```

## Target environment

Every script respects the `K6_TARGET` env var. Default: `http://localhost:4000`.

```bash
# Against local dev
k6 run load/votes-burst.js

# Against staging
K6_TARGET=https://staging.cashfb.com k6 run load/votes-burst.js
```

## DB target and cleanup

Load tests run against the `cashfb_integration` DB + Redis db 15 — same isolation boundary as the integration test suite. Do NOT point them at `cashfb` (dev) or `cashfb_prod` (production).

Boot the docker stack if it's not already up:

```bash
pnpm test:integration:up
```

Cleanup between runs:

```bash
pnpm load:cleanup
# Refuses to run unless MONGO_URI targets cashfb_integration.
```

## One-time setup

The load-test suite needs a seeded admin for `dashboard-cache.js` and for `pnpm load:seed-fcfs` (the FCFS-race prerequisite). Run ONCE per `cashfb_integration` lifecycle:

```bash
pnpm admin:create -- --email=loadtest@cashfb.test
# When prompted for password, enter: LoadTest12345!
# (or export K6_ADMIN_PASSWORD=<your-choice> and pass that at the prompt)
```

Then the dev server must be running any time you invoke `pnpm load:seed-fcfs` — the seed helper talks to the real admin HTTP API (POST /admin/auth/login → /admin/posts → /admin/redeem-codes/upload → /publish). That guarantees the code ciphertext is written by the SAME process that will later decrypt it at claim time — avoiding a cross-process `InMemoryEncryptor` KEK mismatch in dev. In production, KMS is the shared key source so the concern is moot, but the HTTP-API approach is the cleaner pattern in both environments.

## Auth model for the scripts

Two scenarios (`votes-burst`, `fcfs-race`) need authenticated user JWTs. The scripts' `setup()` signs up 100 synthetic users via the dev-mode OTP bypass in `AuthService.verifySignupOtp` (see `src/modules/auth/auth.service.ts` → `shouldBypassSignupOtp`).

The bypass is triply gated:

1. `env.NODE_ENV === 'development'`
2. Phone matches `/^\+919999990\d{3}$/` (reserved load-test range: `+919999990000` to `+919999990999`)
3. Request body carries `_devBypassOtp: true`

Any one failing = standard OTP verification. Production refuses the bypass unconditionally.

The dashboard-cache script uses a separate path: logs in as a pre-seeded admin. Before the first run:

```bash
pnpm admin:create -- --email=loadtest@cashfb.test
# When prompted for password, use `LoadTest12345!` (or export K6_ADMIN_PASSWORD).
```

## Scripts

| Script               | Shape                                | Threshold (fails run if breached)                               |
| -------------------- | ------------------------------------ | --------------------------------------------------------------- |
| `votes-burst.js`     | 100 VUs × 1 vote each, 10s window    | p95 vote latency < 500 ms; checks > 99 %; http_req_failed < 1 % |
| `fcfs-race.js`       | 1 code, 100 concurrent copy requests | fcfs_success == 1, fcfs_conflict == 99, fcfs_other == 0         |
| `dashboard-cache.js` | 100 rps × 60 s, admin-session        | p95 dashboard latency < 20 ms                                   |
| `webhook-ingest.js`  | 100 rps × 60 s, raw-body HMAC        | p95 webhook latency < 500 ms; error rate < 1 %                  |

### votes-burst

```bash
pnpm load:cleanup
pnpm dev   # in another terminal
k6 run load/votes-burst.js
```

### fcfs-race

Needs a pre-seeded admin (see "One-time setup" above), the dev server running, and a pre-seeded post + code. The seed helper reaches the admin HTTP API — so the dev server must already be up before you run it:

```bash
pnpm load:cleanup
pnpm dev   # in another terminal — leave running
pnpm load:seed-fcfs
# => prints:
#   K6_FCFS_POST_ID=<hex>
#   K6_FCFS_CODE_ID=<hex>

K6_FCFS_POST_ID=<hex> K6_FCFS_CODE_ID=<hex> k6 run load/fcfs-race.js
```

Or, to export both IDs in one step:

```bash
eval "$(pnpm load:seed-fcfs 2>/dev/null)"
k6 run load/fcfs-race.js
```

### dashboard-cache

Needs the pre-seeded admin (see Auth model above).

```bash
pnpm dev   # in another terminal
k6 run load/dashboard-cache.js
# Optional env overrides:
#   K6_ADMIN_EMAIL=loadtest@cashfb.test
#   K6_ADMIN_PASSWORD=LoadTest12345!
```

### webhook-ingest

No auth needed. Uses `dev-webhook-secret-placeholder` as the default HMAC secret (matches the dev `.env` default); override via `K6_WEBHOOK_SECRET` when hitting staging.

```bash
pnpm dev   # in another terminal
k6 run load/webhook-ingest.js
# For staging:
#   K6_TARGET=https://staging.cashfb.com K6_WEBHOOK_SECRET=<real> \
#     k6 run load/webhook-ingest.js
```

## Thresholds and local vs staging

**Thresholds target staging/prod infrastructure. Local runs may flake due to machine variance. If a threshold fails locally, rerun once; if it still flakes, run on staging. DO NOT loosen thresholds to make local pass — that defeats the purpose.**

## Reports

k6 writes JSON summaries to the `load/reports/` directory when invoked with `--summary-export`:

```bash
k6 run --summary-export=load/reports/votes-burst-$(date +%Y%m%d-%H%M%S).json load/votes-burst.js
```

Reports are git-ignored — only the `.gitkeep` is tracked.

## Adding a new scenario

1. Write `load/<scenario>.js`.
2. If it needs authenticated users, `import { seedUsers } from './_setup/seed-users.js';` in setup().
3. If it needs admin-session state, follow the `dashboard-cache.js` pattern (login → capture cookie + CSRF → reuse).
4. Define thresholds in `options.thresholds` that fail the run on breach.
5. Extend this README with a row in the scripts table + usage snippet.

## Observed baselines

MVP — to be populated after the first local + staging runs. Columns: scenario / p50 / p95 / p99 / error rate. Run on 2025 MacBook Pro M2 + docker-compose'd Mongo + Redis.

| Scenario        | p50   | p95   | p99   | error rate |
| --------------- | ----- | ----- | ----- | ---------- |
| votes-burst     | _TBD_ | _TBD_ | _TBD_ | _TBD_      |
| fcfs-race       | _TBD_ | _TBD_ | _TBD_ | _TBD_      |
| dashboard-cache | _TBD_ | _TBD_ | _TBD_ | _TBD_      |
| webhook-ingest  | _TBD_ | _TBD_ | _TBD_ | _TBD_      |
