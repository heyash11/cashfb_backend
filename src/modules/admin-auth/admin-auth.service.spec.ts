import bcrypt from 'bcrypt';
import type { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { redis } from '../../config/redis.js';
import {
  clearAllCollections,
  connectTestMongo,
  disconnectTestMongo,
} from '../../../test/testing/mongo.js';
import { AdminUserModel } from '../../shared/models/AdminUser.model.js';
import { AppConfigModel } from '../../shared/models/AppConfig.model.js';
import { MODELS } from '../../shared/models/index.js';
import { AdminAuthService } from './admin-auth.service.js';

type AnyModel = { syncIndexes(): Promise<string[]> };

async function mkAdmin(
  overrides: {
    email?: string;
    password?: string;
    role?: 'SUPER_ADMIN' | 'CONTENT_ADMIN' | 'PAYMENT_ADMIN' | 'SUPPORT_ADMIN';
    disabled?: boolean;
    twoFactorEnabled?: boolean;
    ipAllowlist?: string[];
    permissions?: string[];
  } = {},
): Promise<{ id: Types.ObjectId; email: string; password: string }> {
  const password = overrides.password ?? 'correct-horse-battery-staple';
  const email = overrides.email ?? `admin-${Date.now()}-${Math.random()}@cashfb.test`;
  const passwordHash = await bcrypt.hash(password, 4); // low cost for tests
  const doc = await AdminUserModel.create({
    email,
    passwordHash,
    name: 'Test Admin',
    role: overrides.role ?? 'SUPER_ADMIN',
    permissions: overrides.permissions ?? [],
    twoFactor: {
      enabled: overrides.twoFactorEnabled ?? false,
      recoveryCodes: [],
    },
    ipAllowlist: overrides.ipAllowlist ?? [],
    disabled: overrides.disabled ?? false,
  });
  return { id: doc._id, email, password };
}

async function setTenantIpAllowlist(list: string[]): Promise<void> {
  await AppConfigModel.updateOne(
    { key: 'default' },
    { $set: { adminIpAllowlist: list } },
    { upsert: true },
  );
}

async function cleanupSessions(): Promise<void> {
  const keys = await redis.keys('admin:session:*');
  if (keys.length > 0) await redis.del(...keys);
}

beforeAll(async () => {
  await connectTestMongo();
  await Promise.all(Object.values(MODELS).map((m) => (m as unknown as AnyModel).syncIndexes()));
}, 120_000);

afterAll(async () => {
  await disconnectTestMongo();
  await cleanupSessions();
});

beforeEach(async () => {
  await clearAllCollections();
  await cleanupSessions();
});

describe('AdminAuthService.login', () => {
  it('happy path: valid credentials return sessionId + csrfToken + admin payload; session persists in Redis', async () => {
    const svc = new AdminAuthService();
    const admin = await mkAdmin();

    const result = await svc.login({
      email: admin.email,
      password: admin.password,
      ip: '127.0.0.1',
      userAgent: 'vitest',
    });

    expect(result.sessionId).toMatch(/^[0-9a-f]{64}$/);
    expect(result.csrfToken).toMatch(/^[0-9a-f]{64}$/);
    expect(result.admin).toEqual({
      id: String(admin.id),
      email: admin.email,
      role: 'SUPER_ADMIN',
      permissions: [],
      twoFactorEnabled: false,
    });
    expect(result.absoluteExpiresAt).toBeGreaterThan(Date.now());

    // Session recoverable via getCurrentAdmin.
    const current = await svc.getCurrentAdmin(result.sessionId);
    expect(current?.email).toBe(admin.email);
  });

  it('wrong password throws UNAUTHORIZED with generic message (no user-enumeration)', async () => {
    const svc = new AdminAuthService();
    const admin = await mkAdmin();

    await expect(
      svc.login({
        email: admin.email,
        password: 'wrong',
        ip: '127.0.0.1',
        userAgent: 'vitest',
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    // Same code for unknown email — enumeration defense.
    await expect(
      svc.login({
        email: 'nobody@cashfb.test',
        password: 'whatever',
        ip: '127.0.0.1',
        userAgent: 'vitest',
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('disabled admin rejected with UNAUTHORIZED', async () => {
    const svc = new AdminAuthService();
    const admin = await mkAdmin({ disabled: true });

    await expect(
      svc.login({
        email: admin.email,
        password: admin.password,
        ip: '127.0.0.1',
        userAgent: 'vitest',
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('2FA-enabled admin rejected with TWO_FACTOR_NOT_IMPLEMENTED (Phase 8 ships infra only)', async () => {
    const svc = new AdminAuthService();
    const admin = await mkAdmin({ twoFactorEnabled: true });

    await expect(
      svc.login({
        email: admin.email,
        password: admin.password,
        totpCode: '123456',
        ip: '127.0.0.1',
        userAgent: 'vitest',
      }),
    ).rejects.toMatchObject({ code: 'TWO_FACTOR_NOT_IMPLEMENTED' });
  });

  it('tenant IP allowlist enforced: login from an IP outside the list rejected with ADMIN_IP_NOT_ALLOWED (rejectedBy: tenant)', async () => {
    const svc = new AdminAuthService();
    const admin = await mkAdmin();
    await setTenantIpAllowlist(['10.0.0.1', '10.0.0.2']);

    await expect(
      svc.login({
        email: admin.email,
        password: admin.password,
        ip: '10.0.0.99',
        userAgent: 'vitest',
      }),
    ).rejects.toMatchObject({ code: 'ADMIN_IP_NOT_ALLOWED', details: { rejectedBy: 'tenant' } });
  });

  it('per-admin IP allowlist narrows: tenant allowed, admin list rejects → ADMIN_IP_NOT_ALLOWED (rejectedBy: admin)', async () => {
    const svc = new AdminAuthService();
    const admin = await mkAdmin({ ipAllowlist: ['10.0.0.2'] });
    await setTenantIpAllowlist(['10.0.0.1', '10.0.0.2']);

    await expect(
      svc.login({
        email: admin.email,
        password: admin.password,
        ip: '10.0.0.1', // tenant-ok, admin-not-ok
        userAgent: 'vitest',
      }),
    ).rejects.toMatchObject({ code: 'ADMIN_IP_NOT_ALLOWED', details: { rejectedBy: 'admin' } });
  });

  it('empty tenant list = permissive (dev/staging fallback)', async () => {
    const svc = new AdminAuthService();
    const admin = await mkAdmin();
    // No AppConfig seeding → adminIpAllowlist defaults to [].

    const result = await svc.login({
      email: admin.email,
      password: admin.password,
      ip: '198.51.100.42',
      userAgent: 'vitest',
    });
    expect(result.sessionId).toBeTruthy();
  });
});

describe('AdminAuthService.logout + rotateCsrf', () => {
  it('logout destroys the session; subsequent getCurrentAdmin returns null', async () => {
    const svc = new AdminAuthService();
    const admin = await mkAdmin();
    const result = await svc.login({
      email: admin.email,
      password: admin.password,
      ip: '127.0.0.1',
      userAgent: 'vitest',
    });

    await svc.logout(result.sessionId);
    expect(await svc.getCurrentAdmin(result.sessionId)).toBeNull();
  });

  it('rotateCsrf issues a new token; old token no longer matches session state', async () => {
    const svc = new AdminAuthService();
    const admin = await mkAdmin();
    const result = await svc.login({
      email: admin.email,
      password: admin.password,
      ip: '127.0.0.1',
      userAgent: 'vitest',
    });
    const originalToken = result.csrfToken;

    const rotated = await svc.rotateCsrf(result.sessionId);
    expect(rotated?.csrfToken).toMatch(/^[0-9a-f]{64}$/);
    expect(rotated?.csrfToken).not.toBe(originalToken);
  });
});
