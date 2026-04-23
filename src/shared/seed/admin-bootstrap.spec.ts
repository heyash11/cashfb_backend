import bcrypt from 'bcrypt';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  clearAllCollections,
  connectTestMongo,
  disconnectTestMongo,
} from '../../../test/testing/mongo.js';
import { AdminUserModel } from '../models/AdminUser.model.js';
import { MODELS } from '../models/index.js';
import { createAdmin } from './admin-bootstrap.js';

type AnyModel = { syncIndexes(): Promise<string[]> };

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

describe('createAdmin (admin bootstrap)', () => {
  it('creates an admin with bcrypt-hashed password, SUPER_ADMIN role, and empty defaults', async () => {
    const result = await createAdmin({
      email: 'bootstrap@cashfb.test',
      password: 'correct-horse-battery-staple-42',
    });

    expect(result.email).toBe('bootstrap@cashfb.test');
    expect(result.role).toBe('SUPER_ADMIN');

    const row = await AdminUserModel.findById(result.id);
    expect(row).toBeTruthy();
    expect(row?.email).toBe('bootstrap@cashfb.test');
    expect(row?.role).toBe('SUPER_ADMIN');
    expect(row?.disabled).toBe(false);
    expect(row?.twoFactor.enabled).toBe(false);
    expect(row?.ipAllowlist).toEqual([]);
    expect(row?.permissions).toEqual([]);

    expect(row?.passwordHash).toMatch(/^\$2[aby]\$/);
    expect(await bcrypt.compare('correct-horse-battery-staple-42', row!.passwordHash)).toBe(true);

    await expect(
      createAdmin({
        email: 'bootstrap@cashfb.test',
        password: 'different-password-really-different',
      }),
    ).rejects.toThrow(/already exists/);
  });
});
