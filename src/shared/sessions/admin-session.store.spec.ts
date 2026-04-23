import { randomBytes } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { redis } from '../../config/redis.js';
import { AdminSessionStore, type AdminRole } from './admin-session.store.js';

function mkSessionId(): string {
  return `test-${randomBytes(8).toString('hex')}`;
}

function baseInput(overrides: Partial<Parameters<AdminSessionStore['create']>[0]> = {}) {
  return {
    sessionId: mkSessionId(),
    adminId: `admin-${randomBytes(4).toString('hex')}`,
    adminEmail: 'admin@cashfb.test',
    role: 'SUPER_ADMIN' as AdminRole,
    permissions: [],
    ip: '127.0.0.1',
    userAgent: 'vitest',
    csrfToken: `csrf-${randomBytes(8).toString('hex')}`,
    ...overrides,
  };
}

async function cleanupKeysMatching(pattern: string): Promise<void> {
  const keys = await redis.keys(pattern);
  if (keys.length > 0) await redis.del(...keys);
}

beforeEach(async () => {
  await cleanupKeysMatching('admin:session:*');
});

afterAll(async () => {
  await cleanupKeysMatching('admin:session:*');
});

describe('AdminSessionStore', () => {
  it('create + get: round-trips session payload and indexes by adminId', async () => {
    const store = new AdminSessionStore();
    const input = baseInput();
    const created = await store.create(input);

    expect(created.sessionId).toBe(input.sessionId);
    expect(created.createdAt).toBe(created.lastSeenAt);
    expect(created.absoluteExpiresAt - created.createdAt).toBe(4 * 60 * 60 * 1000);

    const fetched = await store.get(input.sessionId);
    expect(fetched).toEqual(created);

    const indexed = await redis.smembers(`admin:session:by-admin:${input.adminId}`);
    expect(indexed).toContain(input.sessionId);
  });

  it('touch: refreshes idle TTL and advances lastSeenAt', async () => {
    let clock = 1_700_000_000_000;
    const store = new AdminSessionStore({ clock: () => clock });
    const input = baseInput();
    const created = await store.create(input);
    expect(created.lastSeenAt).toBe(clock);

    clock += 60_000; // +60s

    const touched = await store.touch(input.sessionId);
    expect(touched).toBeTruthy();
    expect(touched?.lastSeenAt).toBe(clock);

    const ttlMs = await redis.pttl(`admin:session:${input.sessionId}`);
    // Fresh TTL ~ 30 min; tolerate any positive value close to it.
    expect(ttlMs).toBeGreaterThan(29 * 60_000);
    expect(ttlMs).toBeLessThanOrEqual(30 * 60_000);
  });

  it('destroy: removes the session key and the secondary index entry', async () => {
    const store = new AdminSessionStore();
    const input = baseInput();
    await store.create(input);

    await store.destroy(input.sessionId);
    expect(await store.get(input.sessionId)).toBeNull();
    const indexed = await redis.smembers(`admin:session:by-admin:${input.adminId}`);
    expect(indexed).not.toContain(input.sessionId);
  });

  it('destroyAllForAdmin: terminates every session owned by the admin', async () => {
    const store = new AdminSessionStore();
    const adminId = `admin-bulk-${randomBytes(4).toString('hex')}`;
    const a = await store.create(baseInput({ adminId, sessionId: mkSessionId() }));
    const b = await store.create(baseInput({ adminId, sessionId: mkSessionId() }));
    const c = await store.create(baseInput({ adminId, sessionId: mkSessionId() }));

    const count = await store.destroyAllForAdmin(adminId);
    expect(count).toBe(3);

    expect(await store.get(a.sessionId)).toBeNull();
    expect(await store.get(b.sessionId)).toBeNull();
    expect(await store.get(c.sessionId)).toBeNull();
    expect(await redis.exists(`admin:session:by-admin:${adminId}`)).toBe(0);
  });

  it('rotateCsrf: replaces the stored csrfToken and preserves the rest of the session', async () => {
    const store = new AdminSessionStore();
    const input = baseInput();
    await store.create(input);

    const newToken = `csrf-rotated-${randomBytes(6).toString('hex')}`;
    const rotated = await store.rotateCsrf(input.sessionId, newToken);
    expect(rotated?.csrfToken).toBe(newToken);
    expect(rotated?.adminId).toBe(input.adminId);
    expect(rotated?.role).toBe(input.role);

    const fetched = await store.get(input.sessionId);
    expect(fetched?.csrfToken).toBe(newToken);
  });

  it('absolute-expiry rejection: get() returns null and evicts the key after absoluteExpiresAt', async () => {
    let clock = 1_700_000_000_000;
    // 4h absolute TTL, short idle TTL so test finishes quickly.
    const store = new AdminSessionStore({
      clock: () => clock,
      idleTtlMs: 10 * 60_000,
      absoluteTtlMs: 2 * 60_000, // 2 min for test
    });
    const input = baseInput();
    await store.create(input);

    // Jump past the 2-minute absolute boundary.
    clock += 3 * 60_000;

    const fetched = await store.get(input.sessionId);
    expect(fetched).toBeNull();
    // Destroy side-effect: key gone, admin index cleaned.
    expect(await redis.exists(`admin:session:${input.sessionId}`)).toBe(0);
  });

  it('touch on an absolute-expired session returns null (rejects the refresh)', async () => {
    let clock = 1_700_000_000_000;
    const store = new AdminSessionStore({
      clock: () => clock,
      idleTtlMs: 10 * 60_000,
      absoluteTtlMs: 2 * 60_000,
    });
    const input = baseInput();
    await store.create(input);

    clock += 3 * 60_000;
    const touched = await store.touch(input.sessionId);
    expect(touched).toBeNull();
  });
});
