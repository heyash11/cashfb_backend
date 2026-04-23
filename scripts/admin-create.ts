import readline from 'node:readline';
import mongoose from 'mongoose';
import { z } from 'zod';
import { createAdmin, type CreateAdminInput } from '../src/shared/seed/admin-bootstrap.js';

/**
 * One-shot CLI to bootstrap the first SUPER_ADMIN for a fresh
 * environment. `pnpm admin:create -- --email=admin@cashfb.com`
 * prompts for password (no password via CLI args — shell history
 * leak) and writes an AdminUser with role SUPER_ADMIN.
 *
 * The core `createAdmin` lives in `src/shared/seed/admin-bootstrap.ts`
 * so its spec is picked up by the Vitest `src` include glob.
 */

function prompt(question: string, opts: { silent?: boolean } = {}): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    if (opts.silent) {
      const stdoutWrite = process.stdout.write.bind(process.stdout);
      let muted = false;
      rl.question(question, (answer) => {
        process.stdout.write = stdoutWrite;
        process.stdout.write('\n');
        rl.close();
        resolve(answer);
      });
      muted = true;
      process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
        if (muted && typeof chunk === 'string' && chunk !== '\n') return true;
        return stdoutWrite(chunk, ...(rest as [never]));
      }) as typeof process.stdout.write;
    } else {
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer.trim());
      });
    }
  });
}

function parseArgs(argv: string[]): { email?: string; name?: string } {
  const out: { email?: string; name?: string } = {};
  for (const arg of argv.slice(2)) {
    const eq = arg.indexOf('=');
    if (eq === -1 || !arg.startsWith('--')) continue;
    const key = arg.slice(2, eq);
    const value = arg.slice(eq + 1);
    if (key === 'email') out.email = value;
    if (key === 'name') out.name = value;
  }
  return out;
}

async function main(): Promise<void> {
  const EnvSchema = z.object({ MONGO_URI: z.string().min(1) });
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    process.stderr.write('[admin-create] MONGO_URI not set\n');
    process.exit(1);
  }

  const args = parseArgs(process.argv);
  const email = args.email ?? (await prompt('Admin email: '));
  const password = await prompt('Admin password (min 12 chars): ', { silent: true });
  const passwordConfirm = await prompt('Confirm password: ', { silent: true });
  if (password !== passwordConfirm) {
    process.stderr.write('[admin-create] passwords do not match\n');
    process.exit(1);
  }

  process.stdout.write('[admin-create] connecting to mongo…\n');
  await mongoose.connect(parsed.data.MONGO_URI);
  try {
    const input: CreateAdminInput = { email, password };
    if (args.name !== undefined) input.name = args.name;
    const result = await createAdmin(input);
    process.stdout.write(
      `[admin-create] created admin ${result.id} (${result.email}, ${result.role})\n`,
    );
  } finally {
    await mongoose.disconnect();
  }
}

const entry = process.argv[1];
if (entry && /admin-create\.ts$/.test(entry)) {
  main().catch((err: unknown) => {
    process.stderr.write(
      `[admin-create] failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}
