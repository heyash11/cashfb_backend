/**
 * Phase 9 Chunk 4 — DPDP erasure smoke harness. Seeds three users
 * (eligible / held / not-yet-expired), invokes the sweep handler
 * directly, reports what landed vs what didn't. Plus an OTP
 * re-signup check.
 *
 * Run with the integration-suite environment so we target the
 * cashfb_integration DB + Redis db 15 and don't pollute dev:
 *   MONGO_URI='mongodb://localhost:27018/cashfb_integration?directConnection=true' \
 *   REDIS_URL='redis://localhost:6380/15' \
 *   npx tsx scripts/dpdp-smoke.ts
 */
import mongoose from 'mongoose';
import { AuthService } from '../src/modules/auth/auth.service.js';
import { OtpServiceImpl } from '../src/modules/auth/otp.service.js';
import type { OtpPurpose, OtpSender } from '../src/modules/auth/otp.types.js';
import { RedisLockoutStore } from '../src/modules/auth/lockout.store.js';
import { redis } from '../src/config/redis.js';
import { initJwtKeys } from '../src/shared/jwt/signer.js';
import { AuditLogModel } from '../src/shared/models/AuditLog.model.js';
import { DonationModel } from '../src/shared/models/Donation.model.js';
import { LoginSessionModel } from '../src/shared/models/LoginSession.model.js';
import { UserModel } from '../src/shared/models/User.model.js';
import { hashPhoneForTombstone } from '../src/shared/utils/anonymize.js';
import { createUserAnonymizeSweepHandler } from '../src/workers/user-anonymize-sweep.worker.js';

class CaptureOtp implements OtpSender {
  latest = new Map<string, string>();
  async send(phone: string, otp: string, _purpose: OtpPurpose): Promise<void> {
    this.latest.set(phone, otp);
  }
}

function section(title: string): void {
  process.stderr.write(`\n=== ${title} ===\n`);
}
function ok(msg: string): void {
  process.stderr.write(`  [OK] ${msg}\n`);
}
function fail(msg: string): void {
  process.stderr.write(`  [FAIL] ${msg}\n`);
  process.exitCode = 1;
}

async function main(): Promise<void> {
  const uri = process.env['MONGO_URI'];
  if (!uri?.includes('cashfb_integration')) {
    throw new Error('DPDP smoke refuses to run: MONGO_URI must target cashfb_integration');
  }
  await mongoose.connect(uri);
  await initJwtKeys();

  // Start clean.
  await Promise.all([
    UserModel.deleteMany({}),
    AuditLogModel.deleteMany({}),
    DonationModel.deleteMany({}),
    LoginSessionModel.deleteMany({}),
  ]);
  await redis.flushdb();

  // --- Seed three users ---
  section('SEED');
  const now = new Date();
  const thirtyOneDaysAgo = new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000);
  const fifteenDaysAgo = new Date(now.getTime() - 15 * 24 * 60 * 60 * 1000);

  const eligible = await UserModel.create({
    phone: '+919000100001',
    email: 'eligible@example.com',
    displayName: 'Eligible Original',
    avatarUrl: 'https://cdn.test/a.png',
    socialLinks: { youtube: 'https://yt/eligible' },
    dob: new Date('1995-01-01'),
    declaredState: 'IN-MH',
    tier: 'PUBLIC',
    deletedAt: thirtyOneDaysAgo,
    kyc: {
      status: 'VERIFIED',
      panLast4: '9999',
      panCt: 'ct',
      panIv: 'iv',
      panTag: 'tag',
      panDekEnc: 'dek',
    },
  });
  await DonationModel.create({
    userId: eligible._id,
    displayName: 'Eligible Original',
    message: 'Keep going',
    ipAddress: '1.2.3.4',
    amount: 10000,
    razorpayOrderId: `order_${Date.now()}_e`,
    status: 'CAPTURED',
  });
  await LoginSessionModel.create({ userId: eligible._id, jti: 'jti-e', family: 'fam-e' });
  ok(`seeded eligible user ${eligible._id}`);

  const held = await UserModel.create({
    phone: '+919000100002',
    displayName: 'Held Original',
    dob: new Date('1995-01-01'),
    declaredState: 'IN-MH',
    tier: 'PUBLIC',
    deletedAt: thirtyOneDaysAgo,
    erasureHold: { active: true, reason: 'smoke: legal review', at: new Date() },
  });
  ok(`seeded held user ${held._id}`);

  const notExpired = await UserModel.create({
    phone: '+919000100003',
    displayName: 'NotExpired Original',
    dob: new Date('1995-01-01'),
    declaredState: 'IN-MH',
    tier: 'PUBLIC',
    deletedAt: fifteenDaysAgo,
  });
  ok(`seeded not-expired user ${notExpired._id}`);

  // --- Invoke sweep ---
  section('SWEEP');
  const handler = createUserAnonymizeSweepHandler();
  const report = await handler({ scheduledFor: now.toISOString() });
  process.stderr.write(`  report: ${JSON.stringify(report)}\n`);

  // Step 3: verify eligible tombstoned
  const e = await UserModel.findById(eligible._id);
  if (e?.anonymizedAt && e.phone === hashPhoneForTombstone('+919000100001', eligible._id))
    ok('eligible user tombstoned (anonymizedAt set, phone is hash)');
  else
    fail(
      `eligible NOT tombstoned — anonymizedAt=${e?.anonymizedAt?.toISOString()}, phone=${e?.phone}`,
    );
  if (e?.displayName === 'REDACTED_USER') ok('displayName = REDACTED_USER');
  else fail(`displayName = ${e?.displayName}`);
  if (e?.avatarUrl === undefined) ok('avatarUrl $unset');
  else fail(`avatarUrl = ${e?.avatarUrl}`);
  if (e?.kyc.panLast4 === null && e.kyc.panCt === undefined)
    ok('kyc PAN ciphertext + last4 cleared');
  else fail(`kyc = ${JSON.stringify(e?.kyc)}`);

  // Step 4: verify audit_logs row (no pending winners seeded so no ERASURE_WITH_PENDING_WINNINGS)
  const audit = await AuditLogModel.findOne({ 'resource.id': eligible._id });
  if (!audit) ok('no ERASURE_WITH_PENDING_WINNINGS row (no pending winners — expected)');
  else fail(`unexpected audit row: ${JSON.stringify(audit)}`);

  // Step 5: login_sessions cleared for eligible
  const sessCount = await LoginSessionModel.countDocuments({ userId: eligible._id });
  if (sessCount === 0) ok('login_sessions for eligible user: 0');
  else fail(`login_sessions for eligible: ${sessCount}`);

  // Step 6: donation cascade
  const donation = await DonationModel.findOne({ userId: eligible._id });
  if (donation?.displayName === null && donation.message === null && donation.ipAddress === null)
    ok('donation cascade: displayName, message, ipAddress = null');
  else fail(`donation cascade failed: ${JSON.stringify(donation)}`);

  // Step 7: held user skipped
  const h = await UserModel.findById(held._id);
  if (!h?.anonymizedAt) ok('held user skipped (anonymizedAt not set)');
  else fail('held user was anonymized — sweep filter broken');

  // Step 8: not-expired user skipped
  const ne = await UserModel.findById(notExpired._id);
  if (!ne?.anonymizedAt) ok('not-expired user skipped (anonymizedAt not set)');
  else fail('not-expired user was anonymized — sweep filter broken');

  // --- OTP login with anonymized raw phone ---
  section('OTP LOGIN (anonymized user)');
  const sender = new CaptureOtp();
  const lockout = new RedisLockoutStore(redis);
  const otp = new OtpServiceImpl({ sender, lockoutStore: lockout });
  const auth = new AuthService({ otpService: otp });

  const loginRes = await auth.requestLoginOtp({ phone: '+919000100001', ipAddress: '127.0.0.1' });
  if (!sender.latest.has('+919000100001') && loginRes.requestedAt)
    ok('login OTP suppressed (enumeration defence hit — no SMS dispatched)');
  else fail('login OTP was dispatched to anonymized user');

  // --- OTP signup with same raw phone ---
  section('OTP SIGNUP (re-signup with same raw phone)');
  await auth.requestSignupOtp({
    phone: '+919000100001',
    deviceId: 'smoke-dev',
    deviceFingerprint: 'smoke-fp',
    ipAddress: '127.0.0.1',
  });
  const otpCode = sender.latest.get('+919000100001');
  if (!otpCode) {
    fail('signup OTP was not dispatched');
  } else {
    ok(`signup OTP dispatched: ${otpCode}`);
    const signup = await auth.verifySignupOtp({
      phone: '+919000100001',
      otp: otpCode,
      deviceId: 'smoke-dev',
      deviceFingerprint: 'smoke-fp',
      ipAddress: '127.0.0.1',
      userAgent: 'smoke',
      dob: new Date('1998-01-01'),
      declaredState: 'IN-MH',
      referralCode: undefined,
      consentVersion: '1',
      consentAcceptedAt: new Date(),
      privacyPolicyVersion: '1',
    });
    if (signup.user.id !== eligible._id.toHexString())
      ok(`new user _id ≠ old _id (${signup.user.id})`);
    else fail('re-signup reused old _id');
    if (signup.user.phone === '+919000100001') ok('new row has raw plaintext phone');
    else fail(`new row phone = ${signup.user.phone}`);
    // Both rows coexist
    const pairCount = await UserModel.countDocuments({
      $or: [
        { phone: '+919000100001' },
        { phone: hashPhoneForTombstone('+919000100001', eligible._id) },
      ],
    });
    if (pairCount === 2) ok('hash row + plaintext row coexist (2 total for this phone family)');
    else fail(`pair count = ${pairCount}, expected 2`);
  }

  await mongoose.disconnect();
  await redis.quit();
  process.stderr.write(`\n${process.exitCode === 1 ? 'FAILED' : 'ALL GREEN'}\n`);
}

void main().catch((err) => {
  process.stderr.write(`SMOKE CRASH: ${String(err)}\n`);
  process.exit(1);
});
