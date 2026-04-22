# ARCHITECTURE.md

Canonical technical reference for the CashFB backend. When this file disagrees with any other doc, this one wins on technical detail.

---

## 1. System shape

Three deliverables against one backend:

- Flutter mobile app (Android first, iOS optional later)
- Flutter Web admin panel
- Node.js + Express + MongoDB + Socket.IO API

Redis sits beside the API for BullMQ queues, Socket.IO Redis adapter, and rate-limit counters. Razorpay handles donations and subscriptions. S3 holds custom-room result images. Everything AWS-native in ap-south-1.

The single most important constraint: **every user-held balance is in coins, not money**. No wallet, no withdrawal, no INR balance. Prizes are Google Play codes (in kind) and custom-room winnings (fulfilled outside the app). This shape keeps CashFB out of payment-aggregator and PPI regulation.

---

## 2. Clean architecture

Three-layer separation. BullMQ workers and Socket.IO handlers need to reuse services without pulling in Express `req`/`res`. Repository layer isolates Mongoose for unit tests.

```
Controller (HTTP/socket boundary)
    → calls
Service (domain logic, transactions, events)
    → calls
Repository (Mongoose models, .lean() reads)
    → persists in
Model (shared/models/*)
```

**Controllers never import models directly.** Controllers never handle transactions. Services own transactions.

---

## 3. Runtime topology

Two ECS Fargate services from the same Docker image:

- `api-svc` runs `src/server.ts`. Handles HTTP + Socket.IO. Scales 3 to 16 tasks on CPU.
- `worker-svc` runs `src/worker.ts`. Handles BullMQ jobs. Scales 1 to 4 tasks on queue depth.

Both connect to the same MongoDB Atlas cluster (via PrivateLink) and the same ElastiCache Redis. Both load the same env and use the same container (awilix composition root).

Socket.IO broadcasts cross tasks via the Redis adapter. Workers emit via `@socket.io/redis-emitter` without holding the `io` instance.

---

## 4. Data model

Full schemas live in `docs/DATA_MODEL.md`. Collections:

| Collection              | Purpose                                                    |
| ----------------------- | ---------------------------------------------------------- |
| `users`                 | Auth, profile, coin balance, tier, KYC, device fingerprint |
| `subscriptions`         | Razorpay subscription records                              |
| `subscription_payments` | Individual subscription charges with GST breakdown         |
| `donations`             | Razorpay donations                                         |
| `top_donor_rankings`    | Materialised view of donors, refreshed every 5 min         |
| `posts`                 | Daily redeem-code posts                                    |
| `post_completions`      | Which user completed which post (for coin award)           |
| `votes`                 | One per user per day (unique index)                        |
| `coin_transactions`     | Audit log of every coin movement                           |
| `redeem_codes`          | Encrypted Google Play gift codes with FCFS claim state     |
| `redeem_code_batches`   | Upload batches for audit + supplier invoice trail          |
| `prize_pools`           | Daily pool calculation                                     |
| `prize_pool_winners`    | Per-user prize records with TDS                            |
| `custom_rooms`          | BGMI / FF matches with encrypted credentials               |
| `custom_room_results`   | Top 1/2/3 + Extra images                                   |
| `brand_sponsors`        | 3 home-screen slots                                        |
| `ads_config`            | Per-placement ad-network map                               |
| `notifications`         | Push records                                               |
| `otp_verifications`     | Hashed OTPs, TTL-indexed                                   |
| `admin_users`           | Admin accounts with 2FA                                    |
| `audit_logs`            | Admin write actions                                        |
| `cms_content`           | T&C, How-Distribute, FAQ, Privacy, Grievance               |
| `app_config`            | Single-doc runtime config                                  |
| `login_sessions`        | Refresh-token family tracking                              |
| `device_fingerprints`   | Anti-fraud                                                 |
| `webhook_events`        | Razorpay event idempotency                                 |
| `counters`              | Sequential counters (GST invoice numbers)                  |

---

## 5. Authentication

- Phone OTP primary (MSG91 DLT-compliant for India), email OTP fallback (SES).
- Access token: JWT RS256, 15-minute TTL.
- Refresh token: 30-day TTL, rotating, family-tracked. Reuse detection revokes the entire family.
- Device binding: every refresh checks `deviceId` matches the `login_sessions` row.
- 18+ DOB gate at signup (service layer).
- Rate limits: 3 OTP requests per phone per 10 min; 10 verify attempts per IP per 15 min.

Full flow diagrams in `docs/SECURITY.md`.

---

## 6. Core business flows

### Coin economy

| Event              | Transaction type               | Amount | Constraint                                      |
| ------------------ | ------------------------------ | ------ | ----------------------------------------------- |
| Signup             | `SIGNUP_BONUS`                 | +3     | `users.signupBonusGranted` one-way flag         |
| Post completed     | `POST_REWARD`                  | +1     | `{userId, postId}` unique on `post_completions` |
| Vote cast          | `VOTE_SPEND`                   | -3     | `{userId, dayKey}` unique on `votes`            |
| Admin credit/debit | `ADMIN_CREDIT` / `ADMIN_DEBIT` | any    | Audit-logged                                    |

All coin movements happen inside Mongo transactions. `users.coinBalance` is modified only via `$inc`. Every `$inc` has a matching `coin_transactions` insert.

### Daily prize pool

Midnight IST BullMQ cron (`daily-prize-pool`):

1. Count yesterday's votes: `Votes.countDocuments({ dayKey: yesterdayIST })`.
2. Load `app_config.baseRatePerVote` (default 100 paise = ₹1).
3. Compute `totalPool = votes × baseRate`.
4. Split: 70% gift codes, 30% custom rooms.
5. Upsert `prize_pools` for today, publish, emit `pool.published` socket event.

### Gift code FCFS

Copy endpoint is a single atomic Mongo operation:

```ts
const claimed = await RedeemCodes.findOneAndUpdate(
  { _id: codeId, status: 'PUBLISHED' },
  { $set: { status: 'COPIED', firstCopiedBy: userId, firstCopiedAt: new Date() } },
  { new: true },
);
if (!claimed) throw new ConflictError('CODE_TAKEN');
```

The one user whose write wins gets the decrypted code. Everyone else sees 409.

### Razorpay subscription lifecycle

Client creates subscription → backend responds with subscription ID → Razorpay Checkout handles payment → webhook fires. Webhook is the source of truth. Sequence of webhook events: `subscription.authenticated` → `subscription.activated` → `subscription.charged` (repeats monthly) → eventual `subscription.completed` / `cancelled` / `halted`.

Full flow + GST invoicing in `docs/PAYMENTS.md`.

---

## 7. Real-time layer

Socket.IO 4.7 with Redis adapter. Namespaces and rooms:

- `user:<userId>` for direct pushes.
- `tier:PUBLIC` / `tier:PRO` / `tier:PRO_MAX` for tier broadcasts.
- `match:<roomId>` for clients watching a specific custom room.
- `admin` for admin dashboard.
- `global` for site-wide (maintenance, pool updates).

Auth handshake: verify JWT access token + device ID match on connect. Reject otherwise.

Key events:

| Event                    | Direction | When                                       |
| ------------------------ | --------- | ------------------------------------------ |
| `pool.published`         | S to C    | Daily midnight cron runs                   |
| `post.published`         | S to C    | Scheduled post becomes LIVE                |
| `room.credentials`       | S to C    | Room reveal time hits                      |
| `room.result.enabled`    | S to C    | 30 min after match start                   |
| `room.result.published`  | S to C    | Admin uploads results                      |
| `redeem.batch.published` | S to C    | Admin publishes codes to a post            |
| `top-donor.changed`      | S to C    | Top donor cache refresh detects change     |
| `subscription.updated`   | S to C    | Webhook flips user tier                    |
| `coins.updated`          | S to C    | Coin service after vote or post completion |

---

## 8. Background jobs (BullMQ)

| Job                         | Schedule           | Purpose                                            |
| --------------------------- | ------------------ | -------------------------------------------------- |
| `daily-prize-pool`          | `0 0 * * *` IST    | Calculate and publish today's pool                 |
| `publish-post`              | Delayed (per post) | Flip post DRAFT to LIVE                            |
| `reveal-room-credentials`   | Delayed (per room) | Decrypt and broadcast credentials at visibleFromAt |
| `enable-match-result`       | Delayed (per room) | Flip room.resultEnabledAt                          |
| `subscription-expiry-sweep` | `*/15 * * * *`     | Catch subscriptions the webhook missed             |
| `top-donor-cache`           | `*/5 * * * *`      | Refresh materialised ranking                       |
| `redeem-code-reconcile`     | `0 * * * *`        | Flip COPIED > 24 h to CLAIMED                      |
| `antifraud-scan`            | `0 2 * * *` IST    | Flag multi-account patterns                        |
| `audit-archive`             | Weekly             | Move old audit logs to S3                          |

Bull-board mounted at `/admin/queues` (SUPER_ADMIN only, IP-allowlisted in prod).

---

## 9. Security posture

- **Encryption at rest:** KMS envelope (AES-256-GCM + KMS-wrapped DEK) for gift codes, room IDs, room passwords, PAN. LRU DEK cache (5 min, 1000 entries).
- **Transport:** TLS via ALB + CloudFront. HSTS with preload.
- **JWT:** RS256, 15-min access + 30-day rotating refresh, device bound.
- **Rate limits:** `express-rate-limit` + `rate-limit-redis` shared across tasks.
- **Input safety:** `express-mongo-sanitize`, `hpp`, Zod schemas on every endpoint.
- **Webhooks:** Raw body, HMAC-SHA256 verify, idempotency via `webhook_events.eventId`.
- **Anti-fraud:** Device fingerprint, IMEI hash, suspicious-score on `device_fingerprints`, cross-account link detection.
- **Geo-block:** Runtime-editable state list, middleware checks declared state + CloudFront geo header.
- **Age gate:** 18+ enforced at signup via DOB.

Full detail in `docs/SECURITY.md`.

---

## 10. Compliance hooks

Engineering hooks only. Legal sign-off from counsel required per `docs/OPEN_DECISIONS.md` item 1.

- Feature flags for PROGA-adjacent features (`tournaments`, `proContestAccess`).
- Geo-block config.
- PAN collection gate (`app_config.kycThresholdAmount`).
- TDS 194BA: 30% calculation on every `prize_pool_winners` row. Gross-up for in-kind prizes.
- GST invoicing per subscription charge.
- DPDP Act 2023: consent capture, data export endpoint, erasure endpoint (soft-delete + 30-day grace), breach-notification runbook.
- Grievance Officer contact in CMS.
- Audit log retention: 90 days hot, 3 years archive.

---

## 11. Observability

- **Logs:** pino JSON to CloudWatch Logs. Redact `authorization`, `password`, `otp`, `codeCt`, `panCt`.
- **Errors:** Sentry Node SDK via `--import` flag, release tracking from CI.
- **Metrics:** CloudWatch for ECS CPU/memory, ALB 5xx, target p95, Atlas connections, Redis evictions.
- **Alarms:** ALB 5xx > 20 in 5 min; p95 > 1.5 s; ECS CPU > 80%; Redis CPU > 75%; Atlas connections > 80% of pool; NAT egress > 80% expected.
- **Tracing:** OpenTelemetry optional after MVP.

---

## 12. Deployment

AWS ap-south-1 (Mumbai). Full detail in `docs/DEPLOYMENT.md`.

```
Clients (India)
   |
CloudFront (Price Class 200)
   |
ALB (HTTPS, 2 AZ, sticky cookie, idle 300s)
   |
ECS Fargate api-svc  +  ECS Fargate worker-svc
   |                           |
   +---- Redis (ElastiCache) --+
   |
Atlas M20 to M30 via PrivateLink
S3 + CloudFront OAC (uploads, invoices)
SES (transactional email)
FCM (push)
Secrets Manager + SSM Parameter Store
```

---

## 13. Non-goals for MVP

- iOS release (Android first; ship iOS in a later milestone).
- Peer-to-peer anything.
- In-app currency conversion to fiat.
- User-to-user messaging.
- Social feed.
- Referral rewards beyond tracking (earn mechanic can be added later via admin-adjustable coins).
- Multi-language UI (English + Hindi later via i18n layer already in the Flutter app).
- Web version of the consumer app (admin panel is Flutter Web; consumer stays mobile-only).

---

## 14. Questions to ask before starting a phase

1. Is the phase affected by any item in `docs/OPEN_DECISIONS.md`?
2. Does it touch coins, votes, or money? If yes, transactional guarantees required.
3. Does it touch sensitive data? If yes, KMS envelope required.
4. Does it introduce a new dependency? If yes, justify in commit message.
5. Does it need a Socket.IO event? If yes, add to `docs/ARCHITECTURE.md` table.
