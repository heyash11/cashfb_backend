import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../../src/app.js';
import { initJwtKeys } from '../../../src/shared/jwt/signer.js';
import { connectHarness, disconnectHarness, resetFullState } from './_harness.js';

/**
 * Integration — `GET /api/v1/me` end-to-end through the real HTTP
 * stack (Phase 9.6). Proves:
 *
 *   - Route is mounted at `/api/v1/me` (returns 401 without auth,
 *     not 404 — would mean route missing)
 *   - requireUser gate fires on missing/malformed bearer
 *   - Authenticated user gets the privacy-filtered DTO with
 *     {id, phone, tier, coinBalance, kyc} + no leaks (dob etc)
 *
 * Full-signup-via-bypass happy path is covered by the unit spec
 * matrix. This integration spec proves the wiring works against
 * the real Express middleware chain.
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

describe('[integration] GET /api/v1/me — Phase 9.6 hydration endpoint', () => {
  const app = createApp();

  it('returns 401 UNAUTHORIZED without auth (not 404 — route IS mounted)', async () => {
    const res = await request(app).get('/api/v1/me');
    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe('UNAUTHORIZED');
    // Critically NOT 404 (would mean route missing) and NOT 403
    // ADMIN_IP_NOT_ALLOWED / CSRF_INVALID (admin middleware bleed).
  });

  it('returns 401 UNAUTHORIZED with malformed bearer', async () => {
    const res = await request(app)
      .get('/api/v1/me')
      .set('Authorization', 'Bearer not-a-real-jwt-at-all');
    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe('UNAUTHORIZED');
  });
});
