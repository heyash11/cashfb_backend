# CashFB Admin — Postman Collection

Covers every admin endpoint from Phase 8 (Chunks 1–4). 57 requests across 7 folders that mirror the route mounts in [`src/app.ts`](../src/app.ts).

## Import

1. Postman → **File → Import**.
2. Select both files in this directory:
   - `CashFB-Admin.postman_collection.json`
   - `CashFB-Admin.postman_environment.json`
3. Switch the active environment (top-right dropdown) to **CashFB Admin (local)**.
4. Edit the `adminPassword` value — it ships as `CHANGE_ME_BEFORE_USE`. Use the password you set when running `pnpm admin:create`.

## Usage

Open the `_setup / Login (captures cookies + csrfToken)` request and hit **Send**. The response's post-test script writes `csrfToken` to the environment and Postman's cookie jar captures the `cfb_admin_session` cookie. From that point, every other request in the collection inherits the session and auto-injects the `X-CSRF-Token` header on writes (via the collection-level pre-request script).

If login fails, the test script throws a human-readable error:

```
Login failed: { "code": "UNAUTHORIZED", "message": "Invalid credentials" }
```

...visible in Postman's **Test Results** tab rather than cascading as downstream 401s.

## Environment variables

| Key             | Purpose                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------- |
| `baseUrl`       | API root. `http://localhost:4000` for dev; set to staging / prod host for those environments.           |
| `adminEmail`    | The email used for `POST /api/v1/admin/auth/login`.                                                     |
| `adminPassword` | Secret — keep out of screenshots.                                                                       |
| `csrfToken`     | Auto-populated by the Login test script; auto-injected by the pre-request script. Do NOT edit manually. |

## Staging + prod

Duplicate the local environment file and override `baseUrl` + credentials. A typical setup keeps three environments: `CashFB Admin (local)`, `CashFB Admin (staging)`, `CashFB Admin (production)`.

## Notes

- Bull-board lives under `/admin/queues` and is NOT part of this collection; it uses its own HTML UI behind the same middleware chain (`ipAllowlist → adminSession → requireRole('SUPER_ADMIN')`).
- The `POST /redeem-codes/upload` request uses multipart form-data — Postman will prompt you for a file on `file`. CSV format: `code,denomination` per [docs/ADMIN_OPERATIONS.md §2](../docs/ADMIN_OPERATIONS.md).
- Streaming endpoints (`GET /redeem-codes/export`) return raw CSV; Postman shows the stream in the body panel but you can also "Save Response" → "Save to file" for large exports.
