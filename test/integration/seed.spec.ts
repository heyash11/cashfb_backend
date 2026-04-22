import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { AdminUserModel } from '../../src/shared/models/AdminUser.model.js';
import { AppConfigModel } from '../../src/shared/models/AppConfig.model.js';
import { seed } from '../../src/shared/seed/seed.js';

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
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
