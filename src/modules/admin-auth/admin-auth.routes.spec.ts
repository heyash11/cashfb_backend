import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import { ADMIN_SESSION_COOKIE } from '../../shared/middleware/admin-session.js';
import { AdminSessionStore } from '../../shared/sessions/admin-session.store.js';

/**
 * Wiring-level regression guard for Phase 8 Chunk 1. The CSRF
 * middleware file + its unit tests existed in the original chunk
 * but were never plugged into the router — live smoke caught it on
 * /csrf-rotate. This suite asserts both authenticated POST routes
 * actually run csrfCheck and reject writes without the header.
 *
 * No cross-spec session cleanup here — Vitest runs spec files in
 * parallel threads against the shared Redis, and a global wipe
 * would stomp sessions seeded by sibling suites. Each seed uses a
 * unique random sessionId so stale entries are harmless and expire
 * via the idle TTL.
 */

async function seedSession(): Promise<string> {
  const store = new AdminSessionStore();
  const session = await store.create({
    sessionId: `routes-${randomBytes(8).toString('hex')}`,
    adminId: 'admin-routes-test',
    adminEmail: 'routes@cashfb.test',
    role: 'SUPER_ADMIN',
    permissions: [],
    ip: '127.0.0.1',
    userAgent: 'vitest',
    csrfToken: `csrf-${randomBytes(8).toString('hex')}`,
  });
  return session.sessionId;
}

describe('admin-auth routes — CSRF wiring', () => {
  const app = createApp();

  it('POST /logout without X-CSRF-Token returns 403 CSRF_INVALID', async () => {
    const sessionId = await seedSession();
    const res = await request(app)
      .post('/api/v1/admin/auth/logout')
      .set('Cookie', `${ADMIN_SESSION_COOKIE}=${sessionId}`);

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      success: false,
      error: { code: 'CSRF_INVALID' },
    });
  });

  it('POST /csrf-rotate without X-CSRF-Token returns 403 CSRF_INVALID', async () => {
    const sessionId = await seedSession();
    const res = await request(app)
      .post('/api/v1/admin/auth/csrf-rotate')
      .set('Cookie', `${ADMIN_SESSION_COOKIE}=${sessionId}`);

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      success: false,
      error: { code: 'CSRF_INVALID' },
    });
  });
});
