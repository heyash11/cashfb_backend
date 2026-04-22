import bcrypt from 'bcrypt';
import { AdminUserRepository } from '../repositories/AdminUser.repository.js';
import { AppConfigRepository } from '../repositories/AppConfig.repository.js';

export interface SeedInput {
  adminEmail: string;
  adminPassword: string;
  adminName?: string;
}

export interface SeedResult {
  appConfigCreated: boolean; // true on first insert, false on re-run
  adminCreated: boolean;
  adminEmail: string;
}

const BCRYPT_COST = 12;

/**
 * Idempotent seed. Safe to run twice in the same process.
 *
 * - `app_config` is upserted by `{ key: 'default' }`. `$setOnInsert`
 *   means a re-run does not overwrite any admin-edited values.
 * - `admin_users` row for the seed email is created only if absent.
 *   A re-run is a no-op for admin creation.
 *
 * Caller is responsible for `mongoose.connect(uri)` before and
 * `mongoose.disconnect()` after. This lets the integration test
 * drive the lifecycle without the seed spinning up its own connection.
 */
export async function seed(input: SeedInput): Promise<SeedResult> {
  const appCfgRepo = new AppConfigRepository();
  const adminRepo = new AdminUserRepository();

  // 1. App config
  const beforeCfg = await appCfgRepo.getDefault();
  await appCfgRepo.upsertDefault({});
  const appConfigCreated = beforeCfg === null;

  // 2. Super admin
  const beforeAdmin = await adminRepo.findByEmail(input.adminEmail);
  let adminCreated = false;
  if (!beforeAdmin) {
    const passwordHash = await bcrypt.hash(input.adminPassword, BCRYPT_COST);
    await adminRepo.create({
      email: input.adminEmail,
      passwordHash,
      name: input.adminName ?? 'Seed Admin',
      role: 'SUPER_ADMIN',
    });
    adminCreated = true;
  }

  return {
    appConfigCreated,
    adminCreated,
    adminEmail: input.adminEmail,
  };
}
