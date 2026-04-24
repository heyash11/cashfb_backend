import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../../src/app.js';
import { initJwtKeys } from '../../../src/shared/jwt/signer.js';
import { connectHarness, disconnectHarness, resetFullState } from './_harness.js';

/**
 * Integration — user-side HTTP surface mount verification (Phase 9
 * Chunk 5 §20 closure). Proves:
 *
 *   - /api/v1/auth/signup/request-otp is mounted + returns 200
 *     (route exists, reaches the service, enumeration-defence path
 *     — an un-mounted route would return 404)
 *   - /api/v1/me/coins WITHOUT a bearer token returns 401
 *     UNAUTHORIZED (requireUser gate wired correctly; NOT 403
 *     ADMIN_IP_NOT_ALLOWED which would mean admin middleware bled
 *     onto user routes, NOT 404 which would mean route missing)
 *   - /api/v1/votes POST WITHOUT a bearer token returns 401
 *     UNAUTHORIZED (same gate posture on the votes mount)
 *
 * We don't exercise the full signup → token → /me happy path here
 * because the dev-mode OTP bypass is gated on NODE_ENV==='development'
 * and vitest sets NODE_ENV='test' by default. That flow is covered
 * by the k6 load-test seed-users helper against the live dev server
 * (where NODE_ENV is 'development'). See load/README.md §Smoke.
 */

beforeAll(async () => {
  await connectHarness();
  await initJwtKeys();
}, 30_000);

afterAll(async () => {
  await disconnectHarness();
});

beforeEach(async () => {
  await resetFullState();
});

describe('[integration] user HTTP auth — §20 route-mount closure', () => {
  const app = createApp();

  it('auth + /me + votes routes mounted; user-middleware gates wired without admin-middleware bleed', async () => {
    // 1. /auth/signup/request-otp mounted and reaches the service.
    const reqRes = await request(app).post('/api/v1/auth/signup/request-otp').send({
      phone: '+919876543210',
      deviceId: 'integration-http-dev',
      deviceFingerprint: 'integration-http-fp',
    });
    expect(reqRes.status).toBe(200);

    // 2. /me/coins without token → 401 UNAUTHORIZED (requireUser).
    //    NOT 404 (would mean route not mounted).
    //    NOT 403 ADMIN_IP_NOT_ALLOWED (would mean admin middleware bleed).
    //    NOT 403 CSRF_INVALID (same).
    const meRes = await request(app).get('/api/v1/me/coins');
    expect(meRes.status).toBe(401);
    expect(meRes.body.error?.code).toBe('UNAUTHORIZED');

    // 3. /votes POST without token → 401 UNAUTHORIZED.
    //    Same middleware-bleed check.
    const voteRes = await request(app).post('/api/v1/votes').send({});
    expect(voteRes.status).toBe(401);
    expect(voteRes.body.error?.code).toBe('UNAUTHORIZED');

    // 4. /posts GET without token → 401 (Phase 3 posts contract).
    const postsRes = await request(app).get('/api/v1/posts');
    expect(postsRes.status).toBe(401);
    expect(postsRes.body.error?.code).toBe('UNAUTHORIZED');

    // 5. /admin/users WITHOUT admin-session → 401/403 from ADMIN
    //    chain. Sanity check that admin middleware is still wired
    //    on admin routes (user-route mount didn't break admin).
    const adminRes = await request(app).get('/api/v1/admin/users');
    // Either 401 (no session) or 403 (ip-allowlist rejection).
    // Critically NOT 200 (would mean admin middleware stripped).
    expect([401, 403]).toContain(adminRes.status);
  });
});
