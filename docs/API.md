# API.md

Full REST endpoint catalogue. Base path: `/api/v1`. Auth column: **P** = public, **U** = user JWT, **A** = admin JWT, **W** = webhook signature.

**Response envelope (always):**

```json
{ "success": true,  "data": { ... } }
{ "success": false, "error": { "code": "VOTE_ALREADY_CAST", "message": "...", "details": {} } }
```

---

## 1. Auth

| Method | Path                       | Auth        | Rate limit  | Description                                                                                                                        |
| ------ | -------------------------- | ----------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/auth/signup/request-otp` | P           | 3/phone/10m | Body: `{phone, deviceId, deviceFingerprint}`. Blocks if device already linked to blocked user.                                     |
| POST   | `/auth/signup/verify`      | P           | 10/IP/15m   | Body: `{phone, otp, dob, declaredState, deviceId, referralCode?}`. Creates user, credits 3-coin bonus atomically, issues JWT pair. |
| POST   | `/auth/login/request-otp`  | P           | 3/phone/10m | Body: `{phone}`.                                                                                                                   |
| POST   | `/auth/login/verify`       | P           | 10/IP/15m   | Body: `{phone, otp, deviceId}`. Issues JWT pair.                                                                                   |
| POST   | `/auth/refresh`            | P (refresh) | 30/IP/min   | Body: `{refreshToken}`. Rotates refresh, revokes family on reuse.                                                                  |
| POST   | `/auth/logout`             | U           | 10/U/m      | Body: `{refreshToken}`. Revokes this session.                                                                                      |
| POST   | `/auth/logout-all`         | U           | 5/U/h       | Revokes every session for user.                                                                                                    |

**Signup verify response:**

```json
{
  "success": true,
  "data": {
    "user": { "id": "...", "phone": "+91...", "tier": "PUBLIC", "coinBalance": 3 },
    "tokens": { "access": "eyJ...", "refresh": "eyJ...", "accessExpiresIn": 900 }
  }
}
```

---

## 2. User profile

| Method | Path                       | Auth | Description                                                   |
| ------ | -------------------------- | ---- | ------------------------------------------------------------- |
| GET    | `/me`                      | U    | Profile + coinBalance + tier + tierExpiresAt                  |
| PATCH  | `/me`                      | U    | Body: `{displayName?, avatarUrl?, socialLinks?}`              |
| POST   | `/me/kyc/pan`              | U    | Body: `{pan: "ABCDE1234F"}`. Encrypts + stores masked last-4. |
| GET    | `/me/coins?cursor=&limit=` | U    | Paginated coin_transactions                                   |
| GET    | `/me/sessions`             | U    | Active login sessions                                         |
| DELETE | `/me/sessions/:jti`        | U    | Revoke specific session                                       |
| POST   | `/me/device-token`         | U    | Body: `{fcmToken}`. For push notifications.                   |

---

## 3. Home, posts, votes, coins

| Method | Path                     | Auth | Description                                                                                                     |
| ------ | ------------------------ | ---- | --------------------------------------------------------------------------------------------------------------- |
| GET    | `/home`                  | U    | Aggregated payload: top donor, 3 sponsors, today's posts list, today's pool, tier context. Cached in Redis 30s. |
| GET    | `/posts?date=YYYY-MM-DD` | U    | Posts for that day with per-user completion flag.                                                               |
| GET    | `/posts/:id`             | U    | Single post detail + ads config keys.                                                                           |
| POST   | `/posts/:id/complete`    | U    | Award 1 coin atomically. Idempotent via `{userId, postId}` unique. Response: `{coinBalance, alreadyCompleted}`. |
| GET    | `/votes/today`           | U    | `{canVote: boolean, usedAt?: Date}`                                                                             |
| POST   | `/votes`                 | U    | Body: `{target}`. Spends 3 coins, enforces 1/day via unique index. Mongo transaction.                           |

---

## 4. Redeem codes

| Method | Path                             | Auth | Description                                                                                    |
| ------ | -------------------------------- | ---- | ---------------------------------------------------------------------------------------------- |
| GET    | `/posts/:id/redeem-codes`        | U    | Requires `post_completions` row for this user+post. Returns masked codes until user taps copy. |
| POST   | `/redeem-codes/:id/copy`         | U    | Atomic FCFS mark. Returns decrypted code on win, 409 on lose.                                  |
| POST   | `/redeem-codes/:id/mark-claimed` | U    | User self-declares they redeemed it on Google Play. Flips to `CLAIMED`.                        |

---

## 5. Donations

| Method | Path                      | Auth | Description                                                                                                                |
| ------ | ------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/donations/create-order` | P    | Body: `{amountInRupees, displayName?, isAnonymous?, socialLinks?, message?}`. Returns Razorpay `{orderId, amount, keyId}`. |
| POST   | `/donations/verify`       | P    | Body: `{razorpay_order_id, razorpay_payment_id, razorpay_signature}`. Tentative success, authoritative via webhook.        |
| GET    | `/top-donor`              | P    | Cached current top donor doc.                                                                                              |
| GET    | `/top-donors?limit=50`    | P    | Top N from `top_donor_rankings`.                                                                                           |

---

## 6. Subscriptions

| Method | Path                          | Auth | Description                                                                                                     |
| ------ | ----------------------------- | ---- | --------------------------------------------------------------------------------------------------------------- |
| GET    | `/subscriptions/plans`        | U    | Pro and Pro Max plans with GST breakdown.                                                                       |
| POST   | `/subscriptions/create`       | U    | Body: `{tier, billingCycle?}`. Returns Razorpay `{subscriptionId}`.                                             |
| POST   | `/subscriptions/verify`       | U    | Body: `{razorpay_payment_id, razorpay_subscription_id, razorpay_signature}`. Post-authenticate signature check. |
| POST   | `/subscriptions/cancel`       | U    | Body: `{atCycleEnd: boolean}`.                                                                                  |
| GET    | `/subscriptions/mine`         | U    | Current + historical.                                                                                           |
| GET    | `/subscriptions/:id/invoices` | U    | List of GST invoice PDF URLs.                                                                                   |

---

## 7. Custom rooms

| Method | Path                             | Auth | Description                                                                        |
| ------ | -------------------------------- | ---- | ---------------------------------------------------------------------------------- |
| GET    | `/custom-rooms?game=BGMI&page=1` | U    | 8 per page. Credentials decrypted only if `now >= visibleFromAt` and tier matches. |
| GET    | `/custom-rooms/:id/result`       | U    | 404 if `now < resultEnabledAt`. Returns 4 winner tiles + in-room image.            |

---

## 8. Misc

| Method | Path                            | Auth | Description                                                              |
| ------ | ------------------------------- | ---- | ------------------------------------------------------------------------ |
| GET    | `/ads-config`                   | U    | Map of placement key to network + unit IDs. App caches once per session. |
| GET    | `/sponsors`                     | U    | 3 active sponsor slots.                                                  |
| GET    | `/cms/:key`                     | P    | One of `terms`, `how_distribute`, `faq`, `privacy`, `grievance`.         |
| GET    | `/notifications?cursor=&limit=` | U    | Paginated.                                                               |
| POST   | `/notifications/:id/read`       | U    | Mark read.                                                               |

---

## 9. Webhooks

| Method | Path                 | Auth | Description                                                                                |
| ------ | -------------------- | ---- | ------------------------------------------------------------------------------------------ |
| POST   | `/webhooks/razorpay` | W    | Raw body. HMAC-SHA256 verified. Dedupe via `X-Razorpay-Event-Id`. Return 200 on duplicate. |

---

## 10. Admin endpoints (all RBAC-gated, all audit-logged)

All under `/admin/*`. All require admin JWT. Role matrix in `docs/SECURITY.md`.

### Dashboard

- `GET /admin/dashboard/metrics`. DAU, MAU, tier split, votes today, pool today, gift-code availability, active rooms, top donor, MTD revenue.

### Users (SUPPORT_ADMIN +)

- `GET /admin/users?q=&tier=&blocked=&limit=&cursor=`
- `GET /admin/users/:id`
- `PATCH /admin/users/:id/block`. Body `{isBlocked, reason}`.
- `POST /admin/users/:id/coins/adjust`. Body `{amount, note}` (SUPER_ADMIN only).
- `GET /admin/users/:id/coins`. Coin transactions.
- `GET /admin/users/:id/sessions`
- `DELETE /admin/users/:id/sessions`. Force-logout all.

### Posts (CONTENT_ADMIN +)

- `GET /admin/posts?date=&status=`
- `POST /admin/posts`. Body `{title, description?, dayKey, scheduledAt, coinReward?, tierRequired?, adsConfig?}`.
- `POST /admin/posts/bulk`. Body `{posts: [...]}`.
- `PATCH /admin/posts/:id`
- `DELETE /admin/posts/:id`

### Redeem codes (CONTENT_ADMIN +)

- `POST /admin/redeem-codes/batches`. Multipart CSV + supplier info.
- `GET /admin/redeem-codes?status=&batchId=&cursor=`
- `POST /admin/redeem-codes/publish`. Body `{batchId, postId, count}`.
- `PATCH /admin/redeem-codes/:id`. Flip to `CLAIMED` / `VOID`.
- `GET /admin/redeem-codes/audit.csv`. Streaming CSV.

### Custom rooms (CONTENT_ADMIN +)

- `GET /admin/custom-rooms?game=&date=`
- `POST /admin/custom-rooms`. Body encrypts credentials server-side.
- `PATCH /admin/custom-rooms/:id`
- `DELETE /admin/custom-rooms/:id`
- `POST /admin/custom-rooms/:id/result`. Multipart with 5 images (in-room + 4 winner tiles).

### Prize pools (CONTENT_ADMIN +)

- `GET /admin/prize-pools?from=&to=`
- `POST /admin/prize-pools/:dayKey/publish`
- `PATCH /admin/prize-pools/:dayKey`. SUPER_ADMIN only (override base rate / multipliers).
- `GET /admin/prize-pools/:dayKey/winners`
- `PATCH /admin/prize-pools/winners/:id`. Mark payout.

### Donations and sponsors

- `GET /admin/donations?status=&cursor=`
- `PATCH /admin/donations/:id/feature`. Manual top-donor override.
- `GET/POST/PATCH/DELETE /admin/sponsors`

### Subscriptions (PAYMENT_ADMIN +)

- `GET /admin/subscriptions?status=&tier=&cursor=`
- `GET /admin/subscriptions/revenue?from=&to=`. MTD / FY revenue.
- `GET /admin/subscriptions/gst-report.csv`. Streaming CSV per FY.

### CMS + config

- `GET /admin/cms/:key` / `PATCH /admin/cms/:key`
- `GET /admin/app-config` / `PATCH /admin/app-config` (SUPER_ADMIN only)
- `GET /admin/ads-config` / `PATCH /admin/ads-config/:placementKey`

### Notifications

- `POST /admin/notifications/broadcast`. Body `{target: 'ALL'|'TIER:X'|'USER:id', title, body, payload?}`.

### Audit logs (SUPER_ADMIN only)

- `GET /admin/audit-logs?actorId=&action=&from=&to=&cursor=`

### Admin users (SUPER_ADMIN only)

- `POST /admin/admins`. Invite.
- `GET /admin/admins`
- `PATCH /admin/admins/:id/role`
- `PATCH /admin/admins/:id/2fa/enable`

---

## 11. Middleware stack (exact order)

```ts
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({ hsts: { maxAge: 31536000, includeSubDomains: true, preload: true } }));
app.use(cors({ origin: ALLOWED_ORIGINS, credentials: true }));
app.use(compression());
app.use(cookieParser());

// Razorpay webhook needs RAW body. Mount BEFORE express.json.
app.post(
  '/api/v1/webhooks/razorpay',
  express.raw({ type: 'application/json' }),
  razorpayWebhookHandler,
);

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(mongoSanitize({ replaceWith: '_' }));
app.use(hpp());
app.use(httpLogger); // pino-http, adds req.id
app.use(globalLimiter); // 300/IP/min
app.use(geoBlockMiddleware); // reads app_config.blockedStates
app.use('/api/v1', routes);
app.use(errorHandler);
```

---

## 12. Error codes reference

| Code                     | HTTP | Meaning                             |
| ------------------------ | ---- | ----------------------------------- |
| `VALIDATION_FAILED`      | 400  | Zod schema rejected input           |
| `UNAUTHORIZED`           | 401  | Missing/invalid JWT                 |
| `FORBIDDEN`              | 403  | RBAC denied                         |
| `INSUFFICIENT_COINS`     | 402  | Balance below required              |
| `NOT_FOUND`              | 404  | Resource not found                  |
| `VOTE_ALREADY_CAST`      | 409  | User already voted today            |
| `POST_ALREADY_COMPLETED` | 409  | User already completed post         |
| `CODE_TAKEN`             | 409  | Another user won FCFS               |
| `DUPLICATE_WEBHOOK`      | 200  | Idempotent no-op                    |
| `RATE_LIMITED`           | 429  | Too many requests                   |
| `GEO_BLOCKED`            | 451  | State on blocked list               |
| `KYC_REQUIRED`           | 451  | Must submit PAN before claim        |
| `MAINTENANCE_MODE`       | 503  | `app_config.maintenanceMode = true` |

---

## 13. Rate limit defaults

Defined per endpoint above. Shared store: `rate-limit-redis`. Limit keys include `req.ip` and `req.user?.id` where both apply.

Global: 300 req/IP/min.
