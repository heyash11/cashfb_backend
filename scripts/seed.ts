import mongoose from 'mongoose';
import { z } from 'zod';
import { seed } from '../src/shared/seed/seed.js';

const SeedEnvSchema = z.object({
  MONGO_URI: z.string().min(1),
  ADMIN_SEED_EMAIL: z.email(),
  ADMIN_SEED_PASSWORD: z.string().min(8),
  ADMIN_SEED_NAME: z.string().default('Seed Admin'),
});

async function main(): Promise<void> {
  const parsed = SeedEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    process.stderr.write(`[seed] Invalid environment configuration:\n${issues}\n`);
    process.exit(1);
  }
  const env = parsed.data;

  process.stdout.write(`[seed] connecting to mongo…\n`);
  await mongoose.connect(env.MONGO_URI);

  try {
    const result = await seed({
      adminEmail: env.ADMIN_SEED_EMAIL,
      adminPassword: env.ADMIN_SEED_PASSWORD,
      adminName: env.ADMIN_SEED_NAME,
    });
    process.stdout.write(
      `[seed] done: app_config ${result.appConfigCreated ? 'created' : 'kept'}, ` +
        `admin ${result.adminCreated ? 'created' : 'kept'} (${result.adminEmail})\n`,
    );
  } finally {
    await mongoose.disconnect();
  }
}

main().catch(async (err: unknown) => {
  process.stderr.write(`[seed] failed: ${String(err)}\n`);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
