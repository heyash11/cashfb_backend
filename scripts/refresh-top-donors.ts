/**
 * One-shot trigger of `DonationService.refreshTopDonorRanking()`.
 * Used during dev to seed the top_donor_rankings materialized view
 * without waiting for the every-5-minutes cron. Not committed.
 */
import mongoose from 'mongoose';
import { DonationService } from '../src/modules/donations/donations.service.js';

async function main(): Promise<void> {
  const uri = process.env['MONGO_URI'] ?? 'mongodb://localhost:27018/cashfb?directConnection=true';
  await mongoose.connect(uri);
  const svc = new DonationService();
  const result = await svc.refreshTopDonorRanking({ limit: 50 });
  process.stdout.write(`refreshed: ${JSON.stringify(result)}\n`);
  await mongoose.disconnect();
}

void main().catch((e: unknown) => {
  process.stderr.write(`refresh failed: ${e instanceof Error ? e.stack : String(e)}\n`);
  process.exit(1);
});
