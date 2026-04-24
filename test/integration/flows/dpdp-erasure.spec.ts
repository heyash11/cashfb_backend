import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import { AuthService } from '../../../src/modules/auth/auth.service.js';
import { OtpServiceImpl } from '../../../src/modules/auth/otp.service.js';
import type { OtpPurpose, OtpSender } from '../../../src/modules/auth/otp.types.js';
import { RedisLockoutStore } from '../../../src/modules/auth/lockout.store.js';
import { redis } from '../../../src/config/redis.js';
import { initJwtKeys } from '../../../src/shared/jwt/signer.js';
import { AuditLogModel } from '../../../src/shared/models/AuditLog.model.js';
import { DonationModel } from '../../../src/shared/models/Donation.model.js';
import { LoginSessionModel } from '../../../src/shared/models/LoginSession.model.js';
import { PrizePoolWinnerModel } from '../../../src/shared/models/PrizePoolWinner.model.js';
import { UserModel } from '../../../src/shared/models/User.model.js';
import { hashPhoneForTombstone } from '../../../src/shared/utils/anonymize.js';
import { createUserAnonymizeSweepHandler } from '../../../src/workers/user-anonymize-sweep.worker.js';
import { connectHarness, disconnectHarness, resetFullState } from './_harness.js';

/**
 * Integration — DPDP erasure end-to-end (Phase 9 Chunk 4). Runs
 * against the real docker replset + Redis so we can verify the
 * sweep-worker transaction applies atomically across users,
 * donations, notifications, and login_sessions, plus the auth
 * service's anonymized-user rejection paths.
 *
 * Spec 1: 30-day grace expiry triggers anonymization
 *   - user has 2 PENDING prize winners
 *   - sweep runs (clock injected 31d into future)
 *   - user row tombstoned, audit log ERASURE_WITH_PENDING_WINNINGS
 *     written with tdsAccruedPaise + gracePeriodStartedAt, donations
 *     cascaded, login_sessions cleared
 *
 * Spec 2: cancel-during-grace + anonymized-login-rejection + re-signup
 *   - scenario 1: request erasure, cancel during grace, user row
 *     back to normal (deletedAt unset, force-logout key cleared)
 *   - scenario 2: for an already-anonymized user, OTP login-request
 *     returns suppressed enumeration defence (no error leak)
 *   - scenario 3: NEW signup with the same raw phone as an anonymized
 *     user creates a new User row with a fresh _id, old hash-keyed
 *     row untouched, unique index not violated
 */

class CapturingOtpSender implements OtpSender {
  readonly latest: Map<string, string> = new Map();
  async send(phone: string, otp: string, _purpose: OtpPurpose): Promise<void> {
    this.latest.set(phone, otp);
  }
}

beforeAll(async () => {
  await connectHarness();
  await initJwtKeys();
}, 30_000);

afterAll(async () => {
  await disconnectHarness();
});

beforeEach(async () => {
  await resetFullState();
});

describe('[integration] DPDP erasure — sweep anonymization', () => {
  it('grace expiry → user tombstoned, audit log written with tds + cascades, sessions cleared', async () => {
    // Seed a user who requested erasure 31 days ago.
    const user = await UserModel.create({
      phone: '+919000011111',
      email: 'original@example.com',
      displayName: 'Original Name',
      avatarUrl: 'https://cdn.cashfb.com/u/a.png',
      socialLinks: { youtube: 'https://youtube.com/@original' },
      dob: new Date('1995-01-01'),
      declaredState: 'IN-MH',
      tier: 'PRO',
      deletedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
      kyc: {
        status: 'VERIFIED',
        panLast4: '1234',
        panCt: 'ciphertext',
        panIv: 'iv',
        panTag: 'tag',
        panDekEnc: 'dek',
        verifiedAt: new Date(),
      },
    });

    // Two PENDING winners — sweep must emit ERASURE_WITH_PENDING_WINNINGS.
    await PrizePoolWinnerModel.create([
      {
        dayKey: '2026-04-10',
        userId: user._id,
        type: 'GIFT_CODE',
        tier: 'PRO',
        finalAmount: 5000,
        tdsDeducted: 1500,
        payoutStatus: 'PENDING',
      },
      {
        dayKey: '2026-04-15',
        userId: user._id,
        type: 'GIFT_CODE',
        tier: 'PRO',
        finalAmount: 10_000,
        tdsDeducted: 3000,
        payoutStatus: 'PENDING',
      },
    ]);

    // A donation with PII fields + an active login session, both
    // should be cascaded / deleted by the sweep.
    await DonationModel.create({
      userId: user._id,
      displayName: 'Original Name',
      message: 'Keep up the great work!',
      socialLinks: { instagram: 'https://instagram.com/original' },
      ipAddress: '203.0.113.45',
      notes: { creator: 'charity-x' },
      amount: 10_000,
      razorpayOrderId: `order_${Date.now()}`,
      status: 'CAPTURED',
      capturedAt: new Date(),
    });
    await LoginSessionModel.create({
      userId: user._id,
      jti: 'jti-sweep-test',
      family: 'fam-sweep-test',
    });

    // Run the handler via its default findCandidates — the 31-day
    // deletedAt naturally falls inside the eligibility window.
    const handler = createUserAnonymizeSweepHandler();
    const report = await handler({ scheduledFor: new Date().toISOString() });

    expect(report.candidateCount).toBeGreaterThanOrEqual(1);
    expect(report.anonymizedCount).toBeGreaterThanOrEqual(1);
    expect(report.pendingWinningsAuditCount).toBeGreaterThanOrEqual(1);

    const tombstoned = await UserModel.findById(user._id);
    expect(tombstoned?.anonymizedAt).toBeTruthy();
    expect(tombstoned?.phone).toBe(hashPhoneForTombstone('+919000011111', user._id));
    expect(tombstoned?.displayName).toBe('REDACTED_USER');
    expect(tombstoned?.avatarUrl).toBeUndefined();
    // socialLinks is $unset — Mongoose still hydrates the subdoc
    // path but with all leaves undefined. Assert on the leaves
    // rather than the whole object for clarity.
    expect(tombstoned?.socialLinks?.youtube).toBeUndefined();
    expect(tombstoned?.socialLinks?.facebook).toBeUndefined();
    expect(tombstoned?.socialLinks?.instagram).toBeUndefined();
    expect(tombstoned?.kyc.panLast4).toBeNull();
    expect(tombstoned?.kyc.panCt).toBeUndefined();
    expect(tombstoned?.kyc.panIv).toBeUndefined();

    const audit = await AuditLogModel.findOne({
      action: 'ERASURE_WITH_PENDING_WINNINGS',
      'resource.id': user._id,
    }).lean();
    expect(audit).toBeTruthy();
    expect(audit?.actorEmail).toBe('system:anonymize-sweep');
    const after = (audit?.after ?? {}) as Record<string, unknown>;
    expect(after.pendingWinnerCount).toBe(2);
    expect(after.pendingTotalPaise).toBe(15_000);
    expect(after.tdsAccruedPaise).toBe(4500);
    expect(after.pendingDayKeys).toEqual(['2026-04-10', '2026-04-15']);
    expect(after.gracePeriodStartedAt).toBeTruthy();

    const donation = await DonationModel.findOne({ userId: user._id }).lean();
    expect(donation?.displayName).toBeNull();
    expect(donation?.message).toBeNull();
    expect(donation?.socialLinks).toBeNull();
    expect(donation?.ipAddress).toBeNull();
    expect(donation?.notes).toEqual({});

    const sessions = await LoginSessionModel.countDocuments({ userId: user._id });
    expect(sessions).toBe(0);
  });
});

describe('[integration] DPDP erasure — cancel, anonymized login rejection, re-signup', () => {
  it('three scenarios: cancel during grace; anonymized login suppressed; re-signup with same phone creates new row', async () => {
    const sender = new CapturingOtpSender();
    const lockout = new RedisLockoutStore(redis);
    const otpService = new OtpServiceImpl({ sender, lockoutStore: lockout });
    const auth = new AuthService({ otpService });

    // --- Scenario 1: cancel during grace ---
    const requesting = await UserModel.create({
      phone: '+919000022222',
      dob: new Date('1995-01-01'),
      declaredState: 'IN-MH',
      tier: 'PUBLIC',
      deletedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
    });
    const { UserErasureService } =
      await import('../../../src/modules/users/users.erasure.service.js');
    const svc = new UserErasureService();
    const cancelStatus = await svc.cancel(requesting._id);
    expect(cancelStatus.requested).toBe(false);
    const fresh = await UserModel.findById(requesting._id);
    expect(fresh?.deletedAt).toBeUndefined();

    // --- Scenario 2: anonymized user — OTP login-request is suppressed (enumeration defence) ---
    const oldUserId = new Types.ObjectId();
    const anonPhone = '+919000099999';
    await UserModel.create({
      _id: oldUserId,
      phone: hashPhoneForTombstone(anonPhone, oldUserId),
      dob: new Date('1995-01-01'),
      declaredState: 'IN-MH',
      tier: 'PUBLIC',
      displayName: 'REDACTED_USER',
      deletedAt: new Date('2026-03-10T00:00:00Z'),
      anonymizedAt: new Date('2026-04-10T00:00:00Z'),
    });

    // requestLoginOtp against the anonymized user's RAW phone. The
    // AuthService looks up by raw phone; it should miss the hashed
    // row entirely and return the standard enumeration-defence shape
    // without dispatching an OTP.
    const loginResult = await auth.requestLoginOtp({ phone: anonPhone, ipAddress: '127.0.0.1' });
    expect(loginResult.requestedAt).toBeInstanceOf(Date);
    // The CapturingOtpSender never saw an OTP for this phone.
    expect(sender.latest.has(anonPhone)).toBe(false);

    // --- Scenario 3: new signup with the same raw phone ---
    // requestSignupOtp sees no matching row → dispatches OTP.
    await auth.requestSignupOtp({
      phone: anonPhone,
      deviceId: 'dev-resignup',
      deviceFingerprint: 'fp-resignup',
      ipAddress: '127.0.0.1',
    });
    const otp = sender.latest.get(anonPhone);
    expect(otp).toMatch(/^\d{6}$/);

    const signup = await auth.verifySignupOtp({
      phone: anonPhone,
      otp: otp!,
      deviceId: 'dev-resignup',
      deviceFingerprint: 'fp-resignup',
      ipAddress: '127.0.0.1',
      userAgent: 'integration-ua',
      dob: new Date('1998-01-01'),
      declaredState: 'IN-MH',
      referralCode: undefined,
      consentVersion: '1',
      consentAcceptedAt: new Date(),
      privacyPolicyVersion: '1',
    });
    // New user row, fresh _id.
    expect(signup.user.id).not.toBe(oldUserId.toHexString());
    expect(signup.user.phone).toBe(anonPhone);
    expect(signup.user.coinBalance).toBe(3);

    // Old anonymized row is unchanged.
    const oldRow = await UserModel.findById(oldUserId).lean();
    expect(oldRow?.phone).toBe(hashPhoneForTombstone(anonPhone, oldUserId));
    expect(oldRow?.anonymizedAt).toBeTruthy();
    expect(oldRow?.displayName).toBe('REDACTED_USER');

    // Two rows coexist for this phone+hash pair — plaintext miss on the hash row, hit on the new row.
    const byRawPhone = await UserModel.find({ phone: anonPhone }).lean();
    expect(byRawPhone).toHaveLength(1);
    expect(byRawPhone[0]?._id.toString()).toBe(signup.user.id);

    const totalForPair = await UserModel.countDocuments({
      $or: [{ phone: anonPhone }, { phone: hashPhoneForTombstone(anonPhone, oldUserId) }],
    });
    expect(totalForPair).toBe(2);
  });
});
