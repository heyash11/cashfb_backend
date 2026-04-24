# DPDP Erasure — Design and Operator Reference

Phase 9 Chunk 4. Closes `OPEN_DECISIONS.md §13`. Implements the Digital Personal Data Protection Act 2023 erasure right for end users. Ships the state machine, the 30-day grace window, the ops-facing hold/resume controls, and the daily anonymization sweep.

## 1. Rights enabled

- **Right to erasure (DPDP §12).** A user can request deletion of their personal data via `POST /me/account/erasure`. The account enters a 30-day grace window; the user may cancel during that window via `DELETE /me/account/erasure`. After 30 days with no cancel and no admin hold, the sweep worker tombstones the PII in-place and the account becomes "anonymized" (terminal).
- **Right to withdraw consent.** Erasure doubles as consent withdrawal — the consent artefact (`consentVersion`, `consentAcceptedAt`, `privacyPolicyVersion`) is preserved post-anonymization for audit, but re-using the data requires fresh consent on re-signup.
- **Compliance hold (ops).** `SUPER_ADMIN` may pause the anonymization clock for a user via `POST /admin/users/:id/erasure-hold` (e.g. active legal/compliance investigation). Clearing the hold resumes the clock from the paused position — the user does not lose remaining grace.

## 2. Out of scope for this chunk

- **Data export** (`GET /me/export`). Mentioned in SECURITY.md §10 but deferred.
- **Anonymization notification** (email/SMS to the user 7d before sweep). Deferred — needs SES + SMS templates.
- **Admin panel rendering of anonymized audit actors** — tracked in [OPEN_DECISIONS.md §A7 follow-up]. Audit rows are NOT mutated by anonymization; the admin UI must render `actorId` → anonymized user as `REDACTED_USER`.

## 3. State machine

```
             POST /me/account/erasure
   ┌──────────────────────────────────────────┐
   │                                          ▼
┌──────┐                                  ┌───────────┐
│normal│◀──── DELETE /me/account/erasure  │ requested │
│      │      (during grace only)         │ deletedAt │
└──────┘                                  │    set    │
                                          └─────┬─────┘
                                                │
   POST /admin/users/:id/erasure-hold           │
      ┌─────────────────────────────────────────┤
      ▼                                         │
  ┌─────────┐                                   │
  │ on-hold │  DELETE /admin/users/:id/         │
  │erasure  │  erasure-hold (admin)             │
  │ Hold    │──────────────────────────────────▶│
  │.active  │   (clock resumes; deletedAt       │
  │ = true  │    advanced by held duration)     │
  └─────────┘                                   │
                                                │
                    cron sees deletedAt + 30d   │
                    elapsed + no hold           │
                                                ▼
                                          ┌─────────────┐
                                          │ anonymized  │
                                          │ (terminal)  │
                                          │anonymizedAt │
                                          │     set     │
                                          └─────────────┘
```

**Grace-clock accounting on hold/release:**

- Hold-apply writes `erasureHold.at` = now.
- Hold-clear computes `heldDurationMs = (clearedAt - erasureHold.at)` and advances `deletedAt` forward by that amount. The next sweep reads the advanced `deletedAt` and makes its 30-day check against it. This preserves the user's remaining grace regardless of how long the hold lasted.

## 4. User-facing endpoints

| Method | Path                  | Auth        | Body | Response                                                                                               |
| ------ | --------------------- | ----------- | ---- | ------------------------------------------------------------------------------------------------------ |
| POST   | `/me/account/erasure` | requireUser | `{}` | `ErasureStatus` — idempotent; re-requesting during grace does not move `deletedAt`.                    |
| DELETE | `/me/account/erasure` | requireUser | `{}` | `ErasureStatus` — 404 NOT_FOUND if no erasure pending; 400 ALREADY_ANONYMIZED if terminal.             |
| GET    | `/me/account/erasure` | requireUser | —    | `ErasureStatus` — `{requested, deletedAt?, anonymizedAt?, held, daysRemaining?, gracePeriodDays: 30}`. |

Rate-limited to 5 requests/user/hour.

**Side-effects at erasure request:**

- `users.deletedAt = now`.
- Every active `login_sessions` row for the user is revoked (`revokedAt = now`).
- A force-logout Redis cutoff (`auth:force-logout:<userId>`) is written with the current unix-seconds. Any still-valid access token (≤15 min TTL) is rejected at the next `requireUser` hit.

**Side-effects at cancel (during grace):**

- `users.deletedAt` unset; `erasureHold` unset.
- Force-logout Redis key DELETED (not just TTL-expired) so the user can log back in with a fresh OTP immediately. Letting the key live would lock them out for up to 30 days.

## 5. Admin endpoints (SUPER_ADMIN only)

| Method | Path                            | Body                        | Response                                                                                                    |
| ------ | ------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------- |
| POST   | `/admin/users/:id/erasure-hold` | `{reason: string (10-500)}` | `{held: true, heldAt, reason}` — 409 if already held, 409 if no pending erasure, 409 if already anonymized. |
| DELETE | `/admin/users/:id/erasure-hold` | `{}`                        | `{held: false, clearedAt, deletedAtAdvancedTo}` — 409 if not held.                                          |

Both are wrapped by the standard admin audit-log middleware (`action: USER_ERASURE_HOLD` / `USER_ERASURE_HOLD_CLEAR`).

## 6. Anonymization — field-by-field cascade

Applied in one Mongo transaction per user by the sweep worker. If any step fails, the whole transaction rolls back and the next sweep re-attempts.

### 6.1 `users` row (own row)

**`$set`:**

- `phone` → `sha256(phone + ':' + _id.toHexString())` (hex string). Per-row deterministic hash — no collision on the `phone` unique index, preserves dispute-matching property (the user can re-derive the hash with their original `_id`), no external salt (deferred to Phase 10 legal review).
- `email` → same scheme (skipped if user had no email).
- `displayName` → `'REDACTED_USER'`.
- `avatarUrl` → `null`.
- `socialLinks` → `null`.
- `kyc.panLast4` → `null`.
- `anonymizedAt` → now.

**`$unset`:** `kyc.panCt`, `kyc.panIv`, `kyc.panTag`, `kyc.panDekEnc` (PAN envelope ciphertext).

**Preserved:** `_id`, `createdAt`, `tier`, `coinBalance`, `totalCoinsEarned`, `deletedAt`, `consentVersion`, `consentAcceptedAt`, `privacyPolicyVersion` (consent artefact retained for audit). `kyc.status` enum NOT expanded — `anonymizedAt !== null` is the sufficient signal that the row is tombstoned.

### 6.2 Dependent-collection cascades

| Collection                               | Field handling                                                                                                      | Rationale                                                                                                                                                                      |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `donations`                              | `displayName → null`, `message → null`, `socialLinks → null`, `ipAddress → null`, `notes → {}`. `userId` preserved. | Revenue aggregation (`amount`, `status`, `capturedAt`) must keep working. All donor-PII fields nulled. `notes` → `{}` (not null) preserves the Mixed-type contract.            |
| `notifications`                          | `title → null`, `body → null`, `payload → {}`. `userId` preserved.                                                  | Prize amounts / OTP codes / other PII-adjacent content in payload are PII. `userId` kept for admin audit of who received what (counts only; content gone).                     |
| `login_sessions`                         | `deleteMany({userId})`                                                                                              | No PII on row; rows are now stale.                                                                                                                                             |
| `audit_logs`                             | **NOT touched.**                                                                                                    | Regulatory requirement: actor-chain integrity for compliance. The admin-panel viewer must render anonymized actors as `REDACTED_USER` (client-side concern, not row mutation). |
| `coin_transactions`                      | **NOT touched.**                                                                                                    | 7-yr §194BA-adjacent retention.                                                                                                                                                |
| `prize_pool_winners`                     | **NOT touched.**                                                                                                    | 7-yr §194BA TDS retention. `panAtPayout` is already masked to last 4 at payout time.                                                                                           |
| `votes`, `post_completions`              | **NOT touched.**                                                                                                    | `userId` preserved; no PII on row. Aggregate integrity required.                                                                                                               |
| `subscriptions`, `subscription_payments` | **NOT touched.**                                                                                                    | GST invoice retention.                                                                                                                                                         |

### 6.3 Audit row written when pending winnings exist

The sweep MUST NOT silently anonymize a user whose prize payouts are still `PENDING` — TDS 194BA reporting downstream needs to be able to trace the anonymization back to a specific user class. Written FIRST in the transaction so a mid-sweep crash can't leave a tombstoned user with no trace.

```
action: 'ERASURE_WITH_PENDING_WINNINGS'
actorId: user._id                    // self-initiator (see §A2)
actorEmail: 'system:anonymize-sweep'
resource: { kind: 'User', id: user._id }
before: null
after: {
  userId: <hex>,
  gracePeriodStartedAt: <Date>,      // user.deletedAt
  anonymizedAt: <Date>,              // sweep fire time
  pendingWinnerCount: <int>,
  pendingTotalPaise: <int>,          // sum of finalAmount
  tdsAccruedPaise: <int>,            // sum of tdsDeducted
  pendingDayKeys: <string[]>         // sorted, deduplicated
}
```

`actorId` pointing to the user's own `_id` is deliberate per the plan §A2 verdict — the AuditLog schema's `ref: 'AdminUser'` is a Mongoose populate hint, not a runtime FK enforcement. A sweep-emitted row's `actorEmail` ('system:anonymize-sweep') distinguishes it from admin-emitted rows.

## 7. Anonymization sweep worker

- Cron: `10 2 * * *` (02:10 IST daily — 10 min after `tier-expiry-sweep` to avoid Mongo-transaction contention).
- Queue: `cron` (shared, monolithic — routes on `job.name` in `src/worker.ts`).
- Handler: `src/workers/user-anonymize-sweep.worker.ts` → `createUserAnonymizeSweepHandler`.
- Anonymize helper: `src/shared/utils/anonymize.ts` is pure — no I/O, composes the ops that the worker applies transactionally. Testable in isolation.

Find query (per sweep fire):

```js
{
  deletedAt: { $lte: now - 30d },
  anonymizedAt: { $exists: false },
  'erasureHold.active': { $ne: true }
}
```

Backed by a partial index on `users.deletedAt` (`partialFilterExpression: { deletedAt: { $exists: true }, anonymizedAt: { $exists: false } }`) so the query stays O(candidates) instead of O(total users).

## 8. Auth cascade

No new per-request I/O. Coverage layers:

1. **Erasure request** writes the force-logout Redis cutoff. Every subsequent `requireUser` hit calls `forceLogoutStore.assertNotForceLoggedOut` which rejects any token whose `iat` ≤ cutoff. 30-day TTL matches the refresh-token max lifetime.
2. **Refresh path** additionally checks `user.anonymizedAt` (free — the user is already fetched for tier/block). Revokes the token family and returns 401 `UNAUTHORIZED` on hit.
3. **Verify-login-OTP** checks `user.anonymizedAt` after findByPhone (free — already fetched). Covers the narrow race where anonymization lands between OTP send and OTP verify.
4. **`requireUser` middleware** does NOT read from Mongo per the [§A5 SKIP verdict]. The force-logout Redis cutoff is the primary gate.

## 9. OTP re-signup with the same raw phone

Because the anonymized user's `phone` field is a hash (not the raw number), `findByPhone(rawPhone)` returns `null` for anonymized rows. A new signup with the same raw phone:

1. Enumeration-defence path doesn't hit.
2. Signup proceeds — creates a new `User` row with a fresh `_id`.
3. The new row's `phone` is the raw plaintext. Unique index is NOT violated (hash value ≠ raw plaintext).
4. The old anonymized row is unchanged.

Two rows now coexist: one hash-keyed (old, anonymized), one plaintext-keyed (new, live user). No schema surgery required.

## 10. Operator runbook

### 10.1 Verify a specific erasure request landed

```js
db.users.findOne(
  { _id: ObjectId('<userId>') },
  { phone: 1, deletedAt: 1, anonymizedAt: 1, erasureHold: 1 },
);
```

Expected on a fresh request: `deletedAt` set, `anonymizedAt` absent, `erasureHold.active` unset.

### 10.2 Manually trigger the sweep (break-glass)

Normally runs at 02:10 IST. To force a run (e.g. during testing / if cron has been off for a period):

```bash
# Admin-initiated manual sweep — SUPER_ADMIN only.
# (Endpoint TODO: expose via /admin/jobs/:name/run in a later phase.
#  For now, break-glass via mongosh + direct queue enqueue.)
```

### 10.3 Apply an erasure hold

```bash
curl -X POST "$BASE/api/v1/admin/users/$USER_ID/erasure-hold" \
  -b cookies.txt -H "X-CSRF-Token: $CSRF" -H "Content-Type: application/json" \
  -d '{"reason":"Active dispute - case #CFB-2026-042"}'
```

Response: `{held: true, heldAt, reason}`.

### 10.4 Clear an erasure hold

```bash
curl -X DELETE "$BASE/api/v1/admin/users/$USER_ID/erasure-hold" \
  -b cookies.txt -H "X-CSRF-Token: $CSRF" -H "Content-Type: application/json" \
  -d '{}'
```

Response: `{held: false, clearedAt, deletedAtAdvancedTo}`. The next sweep will use the advanced `deletedAt` for its 30-day check.

### 10.5 Inspect the anonymization audit trail

```js
db.audit_logs
  .find({ action: 'ERASURE_WITH_PENDING_WINNINGS' })
  .sort({ createdAt: -1 })
  .limit(20)
  .pretty();
```

Each row has the full payload: `pendingWinnerCount`, `pendingTotalPaise`, `tdsAccruedPaise`, `pendingDayKeys`.

## 11. Regulatory pointers

- DPDP Act 2023 §12 — Right to erasure.
- TDS §194BA — retention of prize-winnings records for 7 years overrides DPDP for those rows specifically. See `docs/SECURITY.md` §10 KYC + TDS.
- GST Invoice Rules — retention of subscription-invoice records for 6 years overrides DPDP for those rows specifically.
