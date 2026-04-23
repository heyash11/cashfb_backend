# CashFB Backend — Claude Code Entry Point

> Hi Claude. You are picking up the **CashFB** backend from the architecture document approved on 22 Apr 2026. This file is your single entry point. Read it end-to-end before making any decision. The owner is **Ashutosh "Ashhu" Patil**, Senior Flutter + Node.js developer, ~6 yrs, Mumbai. He prefers direct, minimal instruction, complete copy-paste-ready code over step-by-step guidance, and natural human tone (no em dashes, no hyphens as dashes).

---

## How to use the `docs/` folder

This repo has a `docs/` folder with detailed reference material. Read the relevant file before starting its corresponding phase. Do not load everything at once.

| File                     | Read before                                |
| ------------------------ | ------------------------------------------ |
| `docs/ARCHITECTURE.md`   | Any architectural decision                 |
| `docs/BUILD_PLAN.md`     | Starting any phase                         |
| `docs/DATA_MODEL.md`     | Phase 1 (database models)                  |
| `docs/API.md`            | Phase 2 onwards (any new endpoint)         |
| `docs/PAYMENTS.md`       | Phase 5 (Razorpay integration)             |
| `docs/SECURITY.md`       | Auth, encryption, compliance work          |
| `docs/DEPLOYMENT.md`     | Phase 9 (infra, CI/CD)                     |
| `docs/CONVENTIONS.md`    | Before every PR                            |
| `docs/GLOSSARY.md`       | When unsure about a domain term            |
| `docs/OPEN_DECISIONS.md` | Before writing code for any undecided area |

---

## 0. CRITICAL — read before anything else

1. **PROGA 2025 risk.** The Promotion and Regulation of Online Gaming Act 2025 may classify two CashFB features as prohibited "online money games": (a) BGMI / Free Fire custom-room tournaments with prizes, and (b) the gift-card contest **when access is gated behind a paid Pro / Pro Max subscription**. Until the project owner confirms legal sign-off, every such feature MUST be behind a feature flag (`featureFlags.tournaments`, `featureFlags.proContestAccess`) and default to `false`. Build the plumbing, do not ship the path.
2. **No wallet, ever.** Coins are not money. There is no INR balance, no withdrawal, no peer-to-peer transfer. Prizes are **only** Google Play gift codes (in kind) and BGMI/FF custom-room winnings (fulfilled outside the app). If a request would create a money balance, stop and ask Ashhu.
3. **First-come-first-serve gift codes.** The atomic primitive is `findOneAndUpdate({_id, status:'PUBLISHED'}, {$set:{status:'COPIED', firstCopiedBy, firstCopiedAt}})`. Do not invent a queue, lottery, or per-user allocation.
4. **Once-per-day vote.** Enforced at the database via the unique compound index `{userId: 1, dayKey: 1}` on the `votes` collection. Every vote write must happen inside a Mongo transaction with the matching `coinBalance` `$inc` and `coin_transactions` insert.
5. **Razorpay webhooks are the source of truth for payments.** Client-side `verify` calls are tentative. Final state changes happen only on webhook receipt with valid signature + idempotency check via `webhook_events.eventId`.
6. **Sensitive fields are KMS-encrypted at rest:** Google Play codes, custom-room IDs, custom-room passwords, PAN. Use the envelope helper in `src/shared/encryption/envelope.ts`. Never store plaintext.
7. **Coding style:** TypeScript strict, ESM, Zod for validation, Mongoose 8 with the repository pattern. **Controllers never import models directly.** Service → Repository → Model.

---

## 1. Project at a glance

**App:** CashFB, India-only, Android-first Flutter app + Flutter Web admin panel + this Node.js backend.

**Revenue:** 100% ad revenue. Goal: keep users in-app 5 to 8 min/session for ₹5 to ₹10 ad revenue per user per session.

**Tiers:** Public (free), Pro (₹59/mo incl. GST, 5x winnings), Pro Max (₹118/mo incl. GST, 10x winnings).

**Coin economy:** 3 coins on signup; +1 per post completed; -3 per vote (once/day); no expiry.

**Prize pool:** Midnight IST cron. `totalPool = yesterday_votes × ₹1`. 70% gift codes, 30% custom rooms.

**Gift codes:** Pre-purchased ₹50 Google Play codes from Google-authorised B2B reseller (Xoxoday / Plum / Zaggle / Qwikcilver / Pine Labs). Admin uploads CSV, system distributes FCFS.

Full detail in `docs/ARCHITECTURE.md`.

---

## 2. Tech stack (locked)

```
Runtime         Node.js 22 LTS, TypeScript 5.6+, ESM, Express 5
Database        MongoDB 7.0 replica set, Mongoose 8.8+, Atlas M20 to M30
Cache / queue   Redis 7.2 (ElastiCache), ioredis 5.x
Realtime        Socket.IO 4.7 + @socket.io/redis-adapter + @socket.io/redis-emitter
Jobs            BullMQ 5.x + @bull-board/express
Auth            jose (RS256) + bcrypt + rotating refresh tokens + device binding
Validation      Zod 4.x
Payments        razorpay 2.9.6 (Node SDK)
Security        helmet, cors, express-mongo-sanitize, hpp, express-rate-limit + rate-limit-redis
Logging         pino + pino-http
Errors          AppError hierarchy + @sentry/node 8.x
DI              awilix 13.x
Encryption      AWS KMS envelope + AES-256-GCM via node:crypto
OTP (India)     MSG91 primary, Twilio fallback
Email           AWS SES ap-south-1
Storage         S3 ap-south-1 + CloudFront OAC
Push            firebase-admin (FCM)
Testing         Vitest 3.2.4 (pin; bump to 4.x after coverage-v8@4 stabilises) + supertest + mongodb-memory-server
Deploy          ECS Fargate ap-south-1, ALB sticky cookie, PrivateLink to Atlas
```

Do not introduce new dependencies without justification in commit message.

---

## 3. Folder structure (create exactly this)

```
cashfb_backend/
├── CLAUDE.md                         # this file
├── README.md                         # human-facing onboarding
├── docs/                             # on-demand reference (see table above)
│   ├── ARCHITECTURE.md
│   ├── BUILD_PLAN.md
│   ├── CONVENTIONS.md
│   ├── API.md
│   ├── DATA_MODEL.md
│   ├── PAYMENTS.md
│   ├── SECURITY.md
│   ├── DEPLOYMENT.md
│   ├── OPEN_DECISIONS.md
│   └── GLOSSARY.md
├── src/
│   ├── config/                       # env, db, redis, logger, kms, razorpay, socket
│   ├── container.ts                  # awilix composition root
│   ├── server.ts                     # Express + HTTP + Socket.IO bootstrap
│   ├── worker.ts                     # BullMQ workers entrypoint
│   ├── instrument.ts                 # Sentry init (--import)
│   ├── modules/                      # feature slices (see below)
│   ├── shared/                       # models, middleware, errors, utils
│   ├── jobs/                         # one file per BullMQ job
│   └── types/                        # ambient .d.ts
├── test/{integration,unit}/
├── scripts/                          # seed, migrate-razorpay-plans
├── .aws/task-def.json
├── .github/workflows/{ci.yml,deploy.yml}
├── Dockerfile
├── docker-compose.dev.yml
├── .env.example
├── .nvmrc
├── package.json
└── tsconfig.json
```

Modules (one per feature slice). Phase annotations reflect actual build order:

```
src/modules/
├── auth/            # Phase 2 (done)
├── posts/           # Phase 3 (done — includes post-completion logic)
├── votes/           # Phase 3 (done)
├── users/           # Phase 3 (only /me/coins; other /me/* endpoints deferred)
├── redeem-codes/    # Phase 4 (done)
├── donations/       # Phase 5 (done)
├── subscriptions/   # Phase 5 (done — +Phase 6 Chunk 3 tier-expiry sweep primitive)
├── webhooks/        # Phase 5 (done)
├── refunds/         # Phase 5 (done — Chunk 4)
├── custom-rooms/    # Phase 6 (done — user + admin; PROGA feature-gated on user paths)
├── prize-pools/     # Phase 6 (done — daily pool compute primitive; Phase 7 wires the cron)
└── admin/           # Phase 8 (planned)
```

Additional slices from the original module list (`home`, `coins`, `sponsors`, `top-donors`, `custom-room-results`, `ads-config`, `notifications`, `cms`) fold into the phases above or land as read-only aggregators in Phase 7+.

Two ECS services run from the same image: `api-svc` (server.ts) and `worker-svc` (worker.ts).

---

## 4. Build sequence (summary)

Full detail with acceptance criteria in `docs/BUILD_PLAN.md`. Summary:

| Phase | Focus                                                          | Days |
| ----- | -------------------------------------------------------------- | ---- |
| 0     | Scaffolding, Docker, CI, env validation, bare boot             | 0.5  |
| 1     | All 27 Mongoose models + repositories + KMS envelope           | 1.5  |
| 2     | Auth: OTP, JWT access/refresh, device binding, RBAC            | 1.5  |
| 3     | Coins, posts, votes with atomic transactions                   | 1    |
| 4     | Redeem codes: bulk upload, publish, FCFS copy                  | 1    |
| 5     | Razorpay: donations + subscriptions + webhooks + GST invoicing | 1.5  |
| 6     | Custom rooms, prize pool cron, top donor cache                 | 1    |
| 7     | Socket.IO + BullMQ polish                                      | 1    |
| 8     | Admin panel API surface                                        | 0.5  |
| 9     | Security hardening, observability, deploy                      | 1    |

Total: ~10 working days for a single senior engineer to MVP-green. Each phase ships green on `pnpm test && pnpm lint && pnpm typecheck` before moving on.

---

## 5. Before writing any code, check these

1. Is the feature I'm about to build affected by **PROGA 2025** or the no-wallet rule? If yes, stop and ask Ashhu.
2. Is there an **open decision** covering this area in `docs/OPEN_DECISIONS.md`? If yes, surface it first.
3. Does this touch **money, coins, or votes**? If yes, it must be inside a Mongo transaction.
4. Does this touch **sensitive data** (gift code, room password, PAN)? If yes, encrypt via the KMS envelope helper.
5. Does this need **idempotency** (webhook handler, payment, daily job)? If yes, use the `webhook_events` dedupe pattern or a unique compound index.

---

## 6. Response style in this repo

- Commit messages: conventional commits (`feat(auth): ...`, `fix(votes): ...`).
- PR titles: imperative, short.
- Code comments: only when the why is not obvious. The what should be in the code.
- When reporting progress to Ashhu, lead with the answer, skip preamble. Match his preference from prior sessions.

---

## 7. First action when Ashhu opens a fresh session

> Phase 0 scaffolding plan: I'll set up package.json (pnpm), tsconfig (strict ESM), ESLint flat + Prettier + Husky, Vitest, Dockerfile (multi-stage distroless), docker-compose for Mongo replset + Redis, env validation with Zod, pino logger, bare Express boot with /health. ETA ~30 mins. Confirm any preferences and I'll begin.

Then wait for confirmation. Do not autopilot.
