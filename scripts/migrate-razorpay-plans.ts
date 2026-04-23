import mongoose from 'mongoose';
import Razorpay from 'razorpay';
import { z } from 'zod';
import { AppConfigModel } from '../src/shared/models/AppConfig.model.js';

/**
 * Creates Pro and Pro Max Razorpay plans (one-time per environment)
 * and writes the returned plan IDs to `app_config.razorpayPlanIds`.
 * Per OPEN_DECISIONS #3, MONTHLY only at launch — yearly deferred
 * post-MVP.
 *
 * Idempotent: if `app_config.razorpayPlanIds.<tier>` is already set,
 * the script skips creation for that tier.
 */

const EnvSchema = z.object({
  MONGO_URI: z.string().min(1),
  RAZORPAY_KEY_ID: z.string().min(1),
  RAZORPAY_KEY_SECRET: z.string().min(1),
});

interface PlanSpec {
  tier: 'PRO' | 'PRO_MAX';
  name: string;
  amount: number; // paise, incl. 18% GST
  description: string;
}

const PLANS: readonly PlanSpec[] = [
  {
    tier: 'PRO',
    name: 'CashFB Pro',
    amount: 5900,
    description: 'Monthly Pro tier (incl. 18% GST)',
  },
  {
    tier: 'PRO_MAX',
    name: 'CashFB Pro Max',
    amount: 11800,
    description: 'Monthly Pro Max tier (incl. 18% GST)',
  },
] as const;

async function main(): Promise<void> {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    process.stderr.write(`[migrate-plans] invalid env:\n${issues}\n`);
    process.exit(1);
  }
  const env = parsed.data;

  process.stdout.write('[migrate-plans] connecting to mongo…\n');
  await mongoose.connect(env.MONGO_URI);

  try {
    const rzp = new Razorpay({ key_id: env.RAZORPAY_KEY_ID, key_secret: env.RAZORPAY_KEY_SECRET });

    const cfg = await AppConfigModel.findOne({ key: 'default' }).lean();
    const existing = cfg?.razorpayPlanIds ?? {};

    for (const plan of PLANS) {
      if (existing[plan.tier]) {
        process.stdout.write(
          `[migrate-plans] ${plan.tier}: already set (${existing[plan.tier]}), skip\n`,
        );
        continue;
      }

      const created = await rzp.plans.create({
        period: 'monthly',
        interval: 1,
        item: {
          name: plan.name,
          amount: plan.amount,
          currency: 'INR',
          description: plan.description,
        },
        notes: { tier: plan.tier, sac: '998439' },
      });

      await AppConfigModel.updateOne(
        { key: 'default' },
        { $set: { [`razorpayPlanIds.${plan.tier}`]: created.id } },
        { upsert: true },
      );
      process.stdout.write(`[migrate-plans] ${plan.tier}: created ${created.id}\n`);
    }

    process.stdout.write('[migrate-plans] done\n');
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(
    `[migrate-plans] fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
