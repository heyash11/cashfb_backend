import { randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearAllCollections,
  connectTestMongo,
  disconnectTestMongo,
} from '../../../test/testing/mongo.js';
import { AppConfigModel } from '../models/AppConfig.model.js';
import { MODELS } from '../models/index.js';
import { AdminSessionStore, type AdminSession } from '../sessions/admin-session.store.js';
import { adminSession, ADMIN_SESSION_COOKIE, extractCookie } from './admin-session.js';
import { CSRF_COOKIE, CSRF_HEADER, csrfCheck } from './csrf.js';
import { ipAllowlist } from './ip-allowlist.js';

type AnyModel = { syncIndexes(): Promise<string[]> };

function mkReq(overrides: Partial<Request> = {}): Request {
  return {
    method: 'GET',
    ip: '127.0.0.1',
    headers: {},
    header(name: string): string | undefined {
      return (this as unknown as Request).headers[name.toLowerCase()] as string | undefined;
    },
    ...overrides,
  } as unknown as Request;
}

function mkRes(): Response {
  return {} as Response;
}

/**
 * No cross-spec Redis cleanup. seedValidSession() uses random hex
 * sessionIds and adminIds so stale entries from prior tests are
 * inert. Bulk-wiping `admin:session:*` would stomp sibling spec
 * files running in parallel worker threads.
 */

beforeAll(async () => {
  await connectTestMongo();
  await Promise.all(Object.values(MODELS).map((m) => (m as unknown as AnyModel).syncIndexes()));
}, 120_000);

afterAll(async () => {
  await disconnectTestMongo();
});

beforeEach(async () => {
  await clearAllCollections();
});

// ---------------------------------------------------------------
// extractCookie (unit, no req/res)
// ---------------------------------------------------------------

describe('extractCookie', () => {
  it('returns undefined when header is absent or key is absent', () => {
    expect(extractCookie(undefined, 'cfb_admin_session')).toBeUndefined();
    expect(extractCookie('other=abc', 'cfb_admin_session')).toBeUndefined();
  });

  it('extracts a value from a multi-cookie header and strips quotes', () => {
    expect(extractCookie('a=1; cfb_admin_session=xyz', 'cfb_admin_session')).toBe('xyz');
    expect(extractCookie('cfb_admin_session="quoted"', 'cfb_admin_session')).toBe('quoted');
  });
});

// ---------------------------------------------------------------
// adminSession middleware
// ---------------------------------------------------------------

async function seedValidSession(): Promise<{
  store: AdminSessionStore;
  session: AdminSession;
}> {
  const store = new AdminSessionStore();
  const session = await store.create({
    sessionId: `test-${randomBytes(8).toString('hex')}`,
    adminId: `admin-${randomBytes(4).toString('hex')}`,
    adminEmail: 'admin@cashfb.test',
    role: 'SUPER_ADMIN',
    permissions: [],
    ip: '127.0.0.1',
    userAgent: 'vitest',
    csrfToken: `csrf-${randomBytes(8).toString('hex')}`,
  });
  return { store, session };
}

describe('adminSession middleware', () => {
  it('accepts a valid session cookie, hydrates req.admin, and calls next()', async () => {
    const { store, session } = await seedValidSession();
    const mw = adminSession({ store });
    const req = mkReq({
      headers: { cookie: `${ADMIN_SESSION_COOKIE}=${session.sessionId}` },
    });
    const next = vi.fn();
    await mw(req, mkRes(), next);

    expect(next).toHaveBeenCalledWith(); // no error arg
    expect(req.admin).toBeTruthy();
    expect(req.admin?.sessionId).toBe(session.sessionId);
  });

  it('rejects missing cookie with UNAUTHORIZED', async () => {
    const mw = adminSession();
    const req = mkReq({ headers: {} });
    const next = vi.fn();
    await mw(req, mkRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'UNAUTHORIZED' }));
    expect(req.admin).toBeUndefined();
  });

  it('rejects an absolute-expired session', async () => {
    let clock = 1_700_000_000_000;
    const store = new AdminSessionStore({
      clock: () => clock,
      idleTtlMs: 10 * 60_000,
      absoluteTtlMs: 2 * 60_000,
    });
    const session = await store.create({
      sessionId: `test-${randomBytes(8).toString('hex')}`,
      adminId: 'admin-expired',
      adminEmail: 'admin@cashfb.test',
      role: 'SUPER_ADMIN',
      permissions: [],
      ip: '127.0.0.1',
      userAgent: 'vitest',
      csrfToken: 'csrf',
    });

    // Jump past absolute expiry.
    clock += 3 * 60_000;

    const mw = adminSession({ store });
    const req = mkReq({
      headers: { cookie: `${ADMIN_SESSION_COOKIE}=${session.sessionId}` },
    });
    const next = vi.fn();
    await mw(req, mkRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'UNAUTHORIZED' }));
  });
});

// ---------------------------------------------------------------
// CSRF middleware
// ---------------------------------------------------------------

describe('csrfCheck middleware', () => {
  it('bypasses GET without touching req.admin', () => {
    const mw = csrfCheck();
    const req = mkReq({ method: 'GET' });
    const next = vi.fn();
    mw(req, mkRes(), next);
    expect(next).toHaveBeenCalledWith();
  });

  it('accepts a POST when cookie, header, and session all agree', () => {
    const token = randomBytes(16).toString('hex');
    const mw = csrfCheck();
    const req = mkReq({
      method: 'POST',
      headers: {
        cookie: `${CSRF_COOKIE}=${token}`,
        [CSRF_HEADER]: token,
      },
      admin: {
        sessionId: 's',
        adminId: 'a',
        adminEmail: 'e',
        role: 'SUPER_ADMIN',
        permissions: [],
        ip: '127.0.0.1',
        userAgent: 'vitest',
        csrfToken: token,
        createdAt: 0,
        lastSeenAt: 0,
        absoluteExpiresAt: Date.now() + 1_000_000,
      },
    } as unknown as Partial<Request>);
    const next = vi.fn();
    mw(req, mkRes(), next);
    expect(next).toHaveBeenCalledWith();
  });

  it('rejects POST with mismatched CSRF header vs session.csrfToken', () => {
    const sessionToken = randomBytes(16).toString('hex');
    const headerToken = randomBytes(16).toString('hex');
    const mw = csrfCheck();
    const req = mkReq({
      method: 'POST',
      headers: {
        cookie: `${CSRF_COOKIE}=${headerToken}`,
        [CSRF_HEADER]: headerToken,
      },
      admin: {
        sessionId: 's',
        adminId: 'a',
        adminEmail: 'e',
        role: 'SUPER_ADMIN',
        permissions: [],
        ip: '127.0.0.1',
        userAgent: 'vitest',
        csrfToken: sessionToken,
        createdAt: 0,
        lastSeenAt: 0,
        absoluteExpiresAt: Date.now() + 1_000_000,
      },
    } as unknown as Partial<Request>);
    const next = vi.fn();
    mw(req, mkRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'CSRF_INVALID' }));
  });
});

// ---------------------------------------------------------------
// ipAllowlist middleware
// ---------------------------------------------------------------

async function setAdminIpAllowlist(list: string[]): Promise<void> {
  await AppConfigModel.updateOne(
    { key: 'default' },
    { $set: { adminIpAllowlist: list } },
    { upsert: true },
  );
}

describe('ipAllowlist middleware', () => {
  it('empty AppConfig list = permissive (dev/staging fallback)', async () => {
    // No seed → defaults to []
    const mw = ipAllowlist();
    const req = mkReq({ ip: '198.51.100.99' });
    const next = vi.fn();
    await mw(req, mkRes(), next);
    expect(next).toHaveBeenCalledWith();
  });

  it('non-empty list admits listed IPs, rejects others with ADMIN_IP_NOT_ALLOWED', async () => {
    await setAdminIpAllowlist(['10.0.0.1', '10.0.0.2']);
    const mw = ipAllowlist();

    const allowedReq = mkReq({ ip: '10.0.0.1' });
    const allowedNext = vi.fn();
    await mw(allowedReq, mkRes(), allowedNext);
    expect(allowedNext).toHaveBeenCalledWith();

    const deniedReq = mkReq({ ip: '10.0.0.99' });
    const deniedNext = vi.fn();
    await mw(deniedReq, mkRes(), deniedNext);
    expect(deniedNext).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'ADMIN_IP_NOT_ALLOWED',
        details: expect.objectContaining({ rejectedBy: 'tenant' }),
      }),
    );
  });
});
