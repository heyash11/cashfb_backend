import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AdminUserModel } from '../../src/shared/models/AdminUser.model.js';
import { AppConfigModel } from '../../src/shared/models/AppConfig.model.js';
import { seed } from '../../src/shared/seed/seed.js';
import { clearAllCollections, connectTestMongo, disconnectTestMongo } from '../testing/mongo.js';

beforeAll(async () => {
  await connectTestMongo();
}, 120_000);

afterAll(async () => {
  await disconnectTestMongo();
});

beforeEach(async () => {
  await clearAllCollections();
});

describe('seed idempotency', () => {
  const input = {
    adminEmail: 'seed-admin@cashfb.test',
    adminPassword: 'correct-horse-battery-staple',
    adminName: 'Seed Admin',
  } as const;

  it('creates app_config and admin on first run, then is a no-op on second run', async () => {
    const first = await seed(input);
    expect(first.appConfigCreated).toBe(true);
    expect(first.adminCreated).toBe(true);

    const second = await seed(input);
    expect(second.appConfigCreated).toBe(false);
    expect(second.adminCreated).toBe(false);

    // Exactly one app_config row.
    const cfgCount = await AppConfigModel.countDocuments({ key: 'default' });
    expect(cfgCount).toBe(1);

    // Exactly one SUPER_ADMIN with the seed email.
    const adminCount = await AdminUserModel.countDocuments({
      email: input.adminEmail,
      role: 'SUPER_ADMIN',
    });
    expect(adminCount).toBe(1);
  });
});
