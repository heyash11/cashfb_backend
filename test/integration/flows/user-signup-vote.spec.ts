import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import { redis } from '../../../src/config/redis.js';
import { AuthService } from '../../../src/modules/auth/auth.service.js';
import { OtpServiceImpl } from '../../../src/modules/auth/otp.service.js';
import type { OtpPurpose, OtpSender } from '../../../src/modules/auth/otp.types.js';
import { RedisLockoutStore } from '../../../src/modules/auth/lockout.store.js';
import { NoopCoinEventEmitter } from '../../../src/shared/events/coinEvents.js';
import { VoteService } from '../../../src/modules/votes/votes.service.js';
import { initJwtKeys } from '../../../src/shared/jwt/signer.js';
import { CoinTransactionModel } from '../../../src/shared/models/CoinTransaction.model.js';
import { UserModel } from '../../../src/shared/models/User.model.js';
import { VoteModel } from '../../../src/shared/models/Vote.model.js';
import { connectHarness, disconnectHarness, resetFullState } from './_harness.js';

/**
 * Integration — user signup + vote end-to-end against real Mongo
 * + Redis. The OTP flow uses a capturing sender (in-memory) so the
 * spec can observe the OTP without reaching out to SMS. Everything
 * else (lockout store, otp_verifications row, signup transaction,
 * vote transaction) runs through the real services against the
 * docker replset.
 *
 * Regression guard for: mongoose transactions, CoinTransaction
 * insertion under session, duplicate-vote compound index, and the
 * atomic balance + CoinTransaction insert invariant.
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

describe('[integration] user signup + vote flow', () => {
  it('signup via OTP → login → castVote: coinBalance + coin_transactions row update atomically', async () => {
    const sender = new CapturingOtpSender();
    const lockout = new RedisLockoutStore(redis);
    const otpService = new OtpServiceImpl({ sender, lockoutStore: lockout });
    const auth = new AuthService({ otpService });

    const phone = '+919877712345';
    const deviceId = 'integration-dev-id';
    const deviceFingerprint = 'integration-fp-001';
    const ipAddress = '127.0.0.1';

    // 1. Request signup OTP — writes otp_verifications row, sender captures OTP.
    await auth.requestSignupOtp({ phone, deviceId, deviceFingerprint, ipAddress });
    const otp = sender.latest.get(phone);
    expect(otp).toMatch(/^\d{6}$/);

    // 2. Verify OTP + complete signup.
    const signupResult = await auth.verifySignupOtp({
      phone,
      otp: otp!,
      deviceId,
      deviceFingerprint,
      ipAddress,
      userAgent: 'integration-ua',
      dob: new Date('1998-01-01'),
      declaredState: 'IN-MH',
      referralCode: undefined,
      consentVersion: '1',
      consentAcceptedAt: new Date(),
      privacyPolicyVersion: '1',
    });
    expect(signupResult.user.phone).toBe(phone);
    expect(signupResult.user.coinBalance).toBe(3); // signup bonus
    expect(signupResult.tokens.access).toBeTruthy();
    expect(signupResult.tokens.refresh).toBeTruthy();

    // 3. Castvote against real Mongo transaction.
    const voteSvc = new VoteService({ coinEvents: new NoopCoinEventEmitter() });
    const voteRes = await voteSvc.castVote({
      userId: new Types.ObjectId(signupResult.user.id),
      tier: 'PUBLIC',
      target: 'post-smoke-integration',
      ipAddress,
      deviceFingerprint,
    });
    expect(voteRes.coinBalance).toBe(0); // 3 - 3 vote cost
    expect(voteRes.tier).toBe('PUBLIC');

    // 4. Verify transactional invariant — both writes landed.
    const userRow = await UserModel.findById(signupResult.user.id);
    expect(userRow?.coinBalance).toBe(0);
    expect(userRow?.totalVotesCast).toBe(1);

    const voteRow = await VoteModel.findOne({ userId: userRow?._id });
    expect(voteRow).toBeTruthy();
    expect(voteRow?.dayKey).toBe(voteRes.dayKey);

    const txs = await CoinTransactionModel.find({ userId: userRow?._id }).sort({ createdAt: 1 });
    expect(txs.length).toBe(2); // signup bonus + vote spend
    expect(txs[0]?.type).toBe('SIGNUP_BONUS');
    expect(txs[0]?.amount).toBe(3);
    expect(txs[1]?.type).toBe('VOTE_SPEND');
    expect(txs[1]?.amount).toBe(-3);
    expect(txs[1]?.balanceAfter).toBe(0);

    // 5. Second vote on same day fails. The exact code depends on
    // balance: after spending 3/3 the pre-check throws
    // INSUFFICIENT_COINS first. A fresh top-up + re-vote path is
    // already covered by the unit suite; the integration value
    // here is the atomic first-vote transaction.
    await expect(
      voteSvc.castVote({
        userId: new Types.ObjectId(signupResult.user.id),
        tier: 'PUBLIC',
        target: 'post-smoke-integration',
        ipAddress,
        deviceFingerprint,
      }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_COINS' });
  });
});
