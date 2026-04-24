/**
 * Phase 9 Chunk 5 — FCFS-race seed helper.
 *
 * Creates one LIVE post + one redeem-code batch + publishes one
 * code to the post — ALL VIA THE REAL ADMIN HTTP API. This must
 * go through the running dev server so the KEK used to encrypt
 * the code plaintext is the SAME in-process KEK the claim path
 * will later use to decrypt it. A cross-process approach (direct
 * service instantiation from this script) produces two distinct
 * ephemeral `InMemoryEncryptor` KEKs, and the one-winning claim
 * fails with "Unsupported state or unable to authenticate data"
 * at the decrypt step.
 *
 * In production, KMS is the shared key source so cross-process
 * seeding would work there; the HTTP-API approach is also fine
 * in prod and is the cleaner pattern regardless.
 *
 * Prerequisites:
 *   - Dev server running on K6_TARGET (default http://localhost:4000)
 *     against cashfb_integration.
 *   - A seeded admin: `pnpm admin:create -- --email=loadtest@cashfb.test`.
 *
 * Prints:
 *   K6_FCFS_POST_ID=<hex>
 *   K6_FCFS_CODE_ID=<hex>
 *
 * Usage:
 *   pnpm load:seed-fcfs
 *   # Copy the two K6_FCFS_* lines into the env, then:
 *   K6_FCFS_POST_ID=<hex> K6_FCFS_CODE_ID=<hex> k6 run load/fcfs-race.js
 */
const TARGET = process.env['K6_TARGET'] ?? 'http://localhost:4000';
const ADMIN_EMAIL = process.env['K6_ADMIN_EMAIL'] ?? 'loadtest@cashfb.test';
const ADMIN_PASSWORD = process.env['K6_ADMIN_PASSWORD'] ?? 'LoadTest12345!';

interface AdminSessionCtx {
  cookie: string;
  csrfToken: string;
}

async function login(): Promise<AdminSessionCtx> {
  const res = await fetch(`${TARGET}/api/v1/admin/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `admin login failed (${res.status}): ${body}\n` +
        `Did you run 'pnpm admin:create -- --email=${ADMIN_EMAIL}' first?`,
    );
  }
  // Login sets TWO cookies: `cfb_admin_session` (HttpOnly, the session
  // id) and `cfb_admin_csrf` (readable, the CSRF double-submit value).
  // csrfCheck middleware requires BOTH the cookie AND an X-CSRF-Token
  // header to be present + equal. We forward both.
  const setCookies = res.headers.getSetCookie();
  let sessionCookie: string | undefined;
  let csrfCookie: string | undefined;
  for (const raw of setCookies) {
    const m = /^([^=]+)=([^;]+)/.exec(raw);
    if (!m) continue;
    if (m[1] === 'cfb_admin_session') sessionCookie = m[2];
    else if (m[1] === 'cfb_admin_csrf') csrfCookie = m[2];
  }
  if (!sessionCookie || !csrfCookie) {
    throw new Error(
      `admin login: missing session or csrf cookie in Set-Cookie (session=${!!sessionCookie}, csrf=${!!csrfCookie})`,
    );
  }
  const body = (await res.json()) as { data: { csrfToken: string } };
  return {
    cookie: `cfb_admin_session=${sessionCookie}; cfb_admin_csrf=${csrfCookie}`,
    csrfToken: body.data.csrfToken,
  };
}

async function createPost(ctx: AdminSessionCtx): Promise<string> {
  const today = new Date().toISOString().slice(0, 10);
  const res = await fetch(`${TARGET}/api/v1/admin/posts`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: ctx.cookie,
      'X-CSRF-Token': ctx.csrfToken,
    },
    body: JSON.stringify({
      title: `Load-test FCFS post ${Date.now()}`,
      dayKey: today,
      scheduledAt: new Date().toISOString(),
      status: 'LIVE',
      coinReward: 1,
      tierRequired: 'PUBLIC',
    }),
  });
  if (!res.ok) {
    throw new Error(`create post failed (${res.status}): ${await res.text()}`);
  }
  const body = (await res.json()) as { data: { _id: string } };
  return body.data._id;
}

async function uploadBatch(ctx: AdminSessionCtx): Promise<string> {
  const csv = `code,denomination\nFCFS-LOAD-${Date.now()},5000\n`;
  const form = new FormData();
  form.append('supplierName', 'Xoxoday');
  form.append('denomination', '5000');
  form.append('file', new Blob([csv], { type: 'text/csv' }), 'codes.csv');

  const res = await fetch(`${TARGET}/api/v1/admin/redeem-codes/upload`, {
    method: 'POST',
    headers: {
      Cookie: ctx.cookie,
      'X-CSRF-Token': ctx.csrfToken,
    },
    body: form,
  });
  if (!res.ok) {
    throw new Error(`upload batch failed (${res.status}): ${await res.text()}`);
  }
  // audit-log middleware unwraps controller result: response is
  // `{success, data: <safeAfter>}` directly (no extra `after` nesting).
  const body = (await res.json()) as { data: { batchId: string } };
  return body.data.batchId;
}

async function publishBatch(
  ctx: AdminSessionCtx,
  batchId: string,
  postId: string,
): Promise<number> {
  const res = await fetch(`${TARGET}/api/v1/admin/redeem-codes/publish`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: ctx.cookie,
      'X-CSRF-Token': ctx.csrfToken,
    },
    body: JSON.stringify({ batchId, postId, count: 1 }),
  });
  if (!res.ok) {
    throw new Error(`publish batch failed (${res.status}): ${await res.text()}`);
  }
  // publishBatchToPost only returns {publishedCount, batchExhausted}
  // — the code _id is not in the response. We fetch it via the list
  // endpoint below. Response body shape is `{success, data: safeAfter}`
  // with `safeAfter = {publishedCount, batchExhausted}`.
  const body = (await res.json()) as { data: { publishedCount: number } };
  return body.data.publishedCount;
}

async function findPublishedCodeId(
  ctx: AdminSessionCtx,
  batchId: string,
  postId: string,
): Promise<string> {
  const url = new URL(`${TARGET}/api/v1/admin/redeem-codes`);
  url.searchParams.set('batchId', batchId);
  url.searchParams.set('postId', postId);
  url.searchParams.set('status', 'PUBLISHED');
  url.searchParams.set('limit', '1');

  const res = await fetch(url, {
    headers: {
      Cookie: ctx.cookie,
      'X-CSRF-Token': ctx.csrfToken,
    },
  });
  if (!res.ok) {
    throw new Error(`list codes failed (${res.status}): ${await res.text()}`);
  }
  const body = (await res.json()) as {
    data: { items: Array<{ _id: string }> };
  };
  const item = body.data.items[0];
  if (!item) {
    throw new Error(
      `list codes returned empty for batchId=${batchId} postId=${postId} status=PUBLISHED — ` +
        'publish may not have committed yet',
    );
  }
  return item._id;
}

async function main(): Promise<void> {
  process.stderr.write(`[load:seed-fcfs] target=${TARGET} admin=${ADMIN_EMAIL}\n`);

  const ctx = await login();
  process.stderr.write('[load:seed-fcfs] admin login OK\n');

  const postId = await createPost(ctx);
  process.stderr.write(`[load:seed-fcfs] post created: ${postId}\n`);

  const batchId = await uploadBatch(ctx);
  process.stderr.write(`[load:seed-fcfs] batch uploaded: ${batchId}\n`);

  const publishedCount = await publishBatch(ctx, batchId, postId);
  if (publishedCount !== 1) {
    throw new Error(`publish returned publishedCount=${publishedCount} — expected exactly 1`);
  }
  const codeId = await findPublishedCodeId(ctx, batchId, postId);

  // Stdout-only so the two lines can be piped into `eval $(...)` for env export.
  process.stdout.write(`K6_FCFS_POST_ID=${postId}\n`);
  process.stdout.write(`K6_FCFS_CODE_ID=${codeId}\n`);
  process.stderr.write(
    `[load:seed-fcfs] seeded via admin HTTP API — same-process KEK guarantees decrypt at claim time.\n`,
  );
}

void main().catch((err: unknown) => {
  process.stderr.write(`[load:seed-fcfs] failed: ${String(err)}\n`);
  process.exit(1);
});
