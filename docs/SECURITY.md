# SECURITY.md

Authentication, encryption, anti-fraud, and compliance engineering for CashFB. Engineering hooks only; legal sign-off is tracked in `docs/OPEN_DECISIONS.md` item 1.

---

## 1. Authentication

### Token strategy

- **Access token:** JWT, RS256, 15-minute TTL. Carries `sub` (user ID), `tier`, `jti`, `iat`, `exp`.
- **Refresh token:** JWT, RS256, 30-day TTL. Carries `sub`, `jti`, `family`, `iat`, `exp`.
- Stored client-side: access in memory, refresh in Flutter `flutter_secure_storage` (maps to iOS Keychain / Android Keystore). Never in `SharedPreferences` in plaintext.

### Refresh rotation + reuse detection

Every refresh:

1. Look up `login_sessions` by `refreshTokenHash = sha256(refreshToken)`, `revokedAt: null`.
2. If not found, but the token parses, look up by `family`. If any session in that family exists (revoked or not), assume **theft**. Revoke the entire family and return 401.
3. If found, validate `deviceId` matches. Reject on mismatch.
4. Mark the current session revoked. Issue a new access + refresh pair in the same family.

```ts
async refresh(refreshToken: string, deviceId: string) {
  const session = await Sessions.findOne({
    refreshTokenHash: sha256(refreshToken),
    revokedAt: null,
  });

  if (!session) {
    // Reuse detection
    const decoded = decodeJwt(refreshToken);
    await Sessions.updateMany(
      { family: decoded.family },
      { $set: { revokedAt: new Date() } }
    );
    throw new UnauthorizedError();
  }

  if (session.deviceId !== deviceId) throw new ForbiddenError();

  await Sessions.updateOne({ _id: session._id }, { $set: { revokedAt: new Date() } });

  const newSession = await this.createSession(session.userId, session.family, deviceId);
  return {
    access:  signAccessJwt({ sub: session.userId, tier: user.tier, jti: newSession.jti }),
    refresh: signRefreshJwt({ sub: session.userId, jti: newSession.jti, family: session.family }),
  };
}
```

### OTP

- MSG91 DLT-registered templates for SMS. DLT compliance mandatory for India.
- Twilio fallback if MSG91 fails.
- 6-digit OTP, 5-min TTL, 5 max attempts.
- Store **hashed** OTP with per-record salt. Never store plaintext.
- Rate limit: 3 OTP requests per phone per 10 min (Redis counter).
- Account lockout: 3 failed verifications, phone locked for 30 min.

### Age gate

At signup, capture DOB, compute age from current IST date. Reject if age < 18. Set `users.ageVerified: true` only on successful PAN verification later (PAN is only issued to adults, so this doubles as confirmation).

---

## 2. Role-based access control

Four admin roles, hard-coded:

| Permission                                   | SUPER_ADMIN | CONTENT_ADMIN | PAYMENT_ADMIN | SUPPORT_ADMIN |
| -------------------------------------------- | ----------- | ------------- | ------------- | ------------- |
| Users read                                   | yes         |               |               | yes           |
| Users block / unblock                        | yes         |               |               | yes           |
| Coin adjust                                  | yes         |               |               |               |
| Posts CRUD                                   | yes         | yes           |               |               |
| Redeem codes CRUD                            | yes         | yes           |               |               |
| Custom rooms CRUD                            | yes         | yes           |               |               |
| Prize pool publish                           | yes         | yes           |               |               |
| Prize pool override (base rate, multipliers) | yes         |               |               |               |
| Sponsors CRUD                                | yes         | yes           |               |               |
| Ads config                                   | yes         | yes           |               |               |
| CMS edit                                     | yes         | yes           |               |               |
| App config                                   | yes         |               |               |               |
| Subscriptions view                           | yes         |               | yes           |               |
| Subscriptions revenue / GST report           | yes         |               | yes           |               |
| Refunds                                      | yes         |               | yes           |               |
| Donations view                               | yes         |               | yes           | yes           |
| Audit logs                                   | yes         |               |               |               |
| Admin users CRUD                             | yes         |               |               |               |
| Push notifications broadcast                 | yes         | yes           |               |               |
| Bull Board / queues                          | yes         |               |               |               |

Middleware: `requireRole('SUPER_ADMIN')` or `requireAnyRole('CONTENT_ADMIN','SUPER_ADMIN')`.

Granular overrides via `admin_users.permissions[]` string array.

2FA (TOTP via `otplib`) required for SUPER_ADMIN. Recovery codes hashed. IP allowlist optional per admin.

---

## 3. Encryption at rest

### What gets encrypted

Fields that would be catastrophic if leaked in a Mongo dump:

- `redeem_codes.code`. Google Play gift card codes.
- `custom_rooms.roomId`, `custom_rooms.roomPwd`. BGMI / FF credentials.
- `users.kyc.pan`. Permanent Account Number.

### Envelope scheme

AWS KMS with customer-managed key. Per-field data encryption keys (DEKs). DEKs wrapped by the KMS Customer Master Key (CMK).

```ts
// src/shared/encryption/envelope.ts
import { KMSClient, GenerateDataKeyCommand, DecryptCommand } from '@aws-sdk/client-kms';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { LRUCache } from 'lru-cache';

const kms = new KMSClient({ region: 'ap-south-1' });
const dekCache = new LRUCache<string, Buffer>({ max: 1000, ttl: 5 * 60_000 });

export async function encryptField(plaintext: string) {
  const { Plaintext, CiphertextBlob } = await kms.send(
    new GenerateDataKeyCommand({ KeyId: env.KMS_KEY_ID, KeySpec: 'AES_256' }),
  );
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Plaintext, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    ct: ct.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    dekEnc: Buffer.from(CiphertextBlob).toString('base64'),
  };
}

export async function decryptField(f: { ct: string; iv: string; tag: string; dekEnc: string }) {
  let dek = dekCache.get(f.dekEnc);
  if (!dek) {
    const { Plaintext } = await kms.send(
      new DecryptCommand({ CiphertextBlob: Buffer.from(f.dekEnc, 'base64') }),
    );
    dek = Buffer.from(Plaintext!);
    dekCache.set(f.dekEnc, dek);
  }
  const decipher = createDecipheriv('aes-256-gcm', dek, Buffer.from(f.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(f.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(f.ct, 'base64')), decipher.final()]).toString(
    'utf8',
  );
}
```

### CMK rotation

Annual, AWS-managed automatic rotation on the KMS CMK. DEKs are per-field and effectively rotated on every write.

### Key access

Only the ECS task role has `kms:GenerateDataKey` and `kms:Decrypt` on the CMK. No human access to the key material.

---

## 4. Transport security

- **TLS everywhere.** ALB terminates TLS 1.2+. ACM-managed certificate.
- **HSTS:** `max-age=31536000; includeSubDomains; preload`.
- **CORS:** explicit allowlist (mobile WebView origins, admin panel domain, localhost for dev).
- **helmet** with sensible defaults.

---

## 5. Input safety

- `express-mongo-sanitize` strips `$` and `.` from keys to block NoSQL injection (`{"email": {"$gt": ""}}` style).
- `hpp` collapses duplicate query parameters.
- Zod validation on every endpoint. Server rejects unknown fields by default (`.strict()`).
- Body size cap: 1 MB on JSON, 25 MB on multipart (for CSV uploads and image uploads).

---

## 6. Rate limiting

`express-rate-limit` + `rate-limit-redis`. Shared counters across ECS tasks.

Per-endpoint limits in `docs/API.md`. Key pattern: `${ip}:${userId ?? 'anon'}:${endpoint}`.

Global: 300 req/IP/min. Burst protection only.

---

## 7. Anti-fraud

### Signals captured

- **Device fingerprint:** Android ID + install UUID + build props, hashed client-side and sent with every auth event.
- **IMEI:** hashed on the client, stored only as `device_fingerprints.imeiHash`. Never raw.
- **IP:** captured per session and per auth event.
- **Install time:** inferred from first-seen timestamp on `device_fingerprints`.

### Detection rules (nightly cron)

- `device_fingerprints.linkedUserIds.length > 3`, `suspiciousScore += 10`, flag for admin review.
- Same IP with > 10 signups in 24 h, temporarily block the IP at rate-limiter level, require captcha.
- User voting pattern deviates from coin earnings (e.g. more votes than possible coin balance minus 2/day for 30 days), flag.
- Refund abuse: > 2 subscription refunds in 6 months, auto-decline further subs for 90 days.

### Actions

- Admin can auto-block all users linked to a flagged device fingerprint in one click.
- User-level soft blocks (coin adjustment disabled, cannot claim codes) preserve the account without deleting data for audit.
- Hard blocks (`blocked.isBlocked = true`) reject all auth attempts.

---

## 8. Webhook security

- Raw body verification (HMAC-SHA256) before any parsing.
- Timing-safe comparison via `crypto.timingSafeEqual`.
- Idempotency via `webhook_events.eventId` unique index.
- Return 200 on duplicates (never 4xx).
- Rate limiter bypass for `/webhooks/*` (Razorpay can burst retries).
- Signing secret stored in Secrets Manager, separate from API key.

---

## 9. Geo-blocking

Runtime-configurable state list in `app_config.blockedStates` (array of ISO 3166-2:IN codes).

```ts
export const geoBlockMiddleware = async (req, res, next) => {
  const cfg = await getCachedAppConfig(); // Redis cache 60s
  const stateFromUser = req.user?.declaredState;
  const stateFromIp = req.headers['cloudfront-viewer-country-region'];
  const state = stateFromUser ?? stateFromIp;

  if (state && cfg.blockedStates.includes(state)) {
    return res.status(451).json({
      success: false,
      error: {
        code: 'GEO_BLOCKED',
        message: 'Service unavailable in your state.',
        details: { state },
      },
    });
  }
  next();
};
```

Default blocked list (pre-PROGA era, kept as plumbing):
`['IN-TG', 'IN-AP', 'IN-TN', 'IN-OR', 'IN-AS', 'IN-NL', 'IN-SK']`

---

## 10. Compliance hooks

### PROGA 2025

Feature flags:

- `featureFlags.tournaments` (custom-room prizes). Default `false` until legal sign-off.
- `featureFlags.proContestAccess` (paid subscription gating contest access). Default `false`.

Architecture supports toggling these on with a single config change, no redeploy.

### TDS 194BA

Every `prize_pool_winners` row computes `tdsDeducted = Math.round(finalAmount * 0.30)`. For in-kind prizes (gift cards), apply gross-up logic: reduce the face value of the awarded code so that `faceValue - TDS = prizeValue`, or collect the tax separately from the winner.

Store `tdsChallanNo` after quarterly deposit via Challan 281. Generate Form 16A quarterly (Form 26Q filing).

### GST

- 18% on subscription revenue. Invoice pipeline in `docs/PAYMENTS.md` §6.
- No GST on in-kind prize payouts.
- Annual turnover thresholds: if CashFB crosses ₹20 lakh / ₹40 lakh depending on state, GST registration is mandatory. Start registered on day one to avoid retro complications.

### DPDP Act 2023

- Consent artefact captured at signup: Zod schema includes `consentVersion`, `consentAcceptedAt`, `privacyPolicyVersion`.
- Data export endpoint: `GET /me/export` returns JSON dump of user's data.
- Erasure endpoint: `DELETE /me` soft-deletes with 30-day grace before anonymisation.
- Breach-notification runbook: 72 h to Data Protection Board of India, 6 h to CERT-In.
- Data minimisation: do not store what we do not need. PAN is lazy-captured at first payout, not at signup.

### IT Rules 2021

- Grievance Officer name + contact in `cms_content.GRIEVANCE`. Surfaced in app Settings.
- Support SLA: 24-h acknowledgement, 15-day resolution.
- Ticketing system integrated into admin panel.

### Audit trail

- 90-day hot retention on `audit_logs`.
- 3-year archive in S3 (NDJSON, gzipped).
- Every admin write action logged: `actor`, `action`, `resource`, `before`, `after`, `ip`, `userAgent`.
- User-initiated actions (vote, post complete, code claim) logged via `coin_transactions` and relevant feature collections, not `audit_logs`.

---

## 11. Incident response

### What triggers an incident

- P0: Production data breach, webhook signature bypass, or encryption key leak.
- P1: Auth bypass, mass unauthorised coin grant, refund abuse.
- P2: Service down > 5 min, payment flow broken.
- P3: Non-urgent bug.

### Response playbook

1. Acknowledge on-call channel within 5 min (P0/P1) or 30 min (P2).
2. Page SUPER_ADMIN for P0/P1.
3. Contain: disable affected flow via feature flag or `app_config.maintenanceMode`.
4. Remediate: hotfix branch, fast deploy path.
5. Post-mortem: template in `docs/POSTMORTEM_TEMPLATE.md` (to be created during first incident).

### Data breach

If PII is leaked:

- DPBI notification within 72 h.
- CERT-In notification within 6 h.
- Affected user notification as soon as scope is known.
- Public disclosure per DPDP and IT Rules requirements.

---

## 12. Secrets management

- **Secrets Manager** (rotating): Mongo URI (Atlas API key), Razorpay secrets, JWT signing keys, MSG91 key, Twilio auth token, FCM service account JSON.
- **SSM Parameter Store SecureString** (static): Sentry DSN, feature flags, non-rotating config.
- Injected via ECS task definition `secrets:` field. No bootstrap code reads secrets from disk.
- Rotate JWT signing keys every 6 months. Support dual-key (old + new) during rotation window.

---

## 13. Dev-time security

- `.env` gitignored. `.env.example` committed as shape reference.
- Pre-commit hook runs `git-secrets` (or similar) to catch committed credentials.
- Dependabot enabled on GitHub for automated dependency updates.
- `npm audit` run in CI. High / critical severity blocks the build.
- Never log a full user record. Always project to `{id, phone, tier}` for logs.
