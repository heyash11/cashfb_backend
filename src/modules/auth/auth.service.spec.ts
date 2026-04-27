import mongoose, { type Model } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearAllCollections,
  connectTestMongo,
  disconnectTestMongo,
} from '../../../test/testing/mongo.js';
import {
  __resetJwtKeysForTesting,
  hashRefreshToken,
  initJwtKeys,
  signRefreshToken,
  verifyRefreshToken,
} from '../../shared/jwt/signer.js';
import { runBumpTokenVersions } from '../../migrations/phase-11-5/drop-legacy-tier-fields.js';
import { CoinTransactionModel } from '../../shared/models/CoinTransaction.model.js';
import { DeviceFingerprintModel } from '../../shared/models/DeviceFingerprint.model.js';
import { LoginSessionModel } from '../../shared/models/LoginSession.model.js';
import { UserModel } from '../../shared/models/User.model.js';
import { MODELS } from '../../shared/models/index.js';
import { CoinTransactionRepository } from '../../shared/repositories/CoinTransaction.repository.js';
import { AuthService } from './auth.service.js';
import type { OtpSendInput, OtpService, OtpVerifyInput } from './otp.types.js';

// ---- Test fixtures ----

const SIGNUP_DEFAULTS = {
  phone: '+919000000001',
  otp: '123456',
  dob: new Date('2000-01-01'),
  declaredState: 'IN-MH',
  referralCode: undefined as string | undefined,
  consentVersion: 'v1',
  consentAcceptedAt: new Date(),
  privacyPolicyVersion: 'v1',
  deviceId: 'dev-1',
  deviceFingerprint: 'fp-1',
  ipAddress: '127.0.0.1',
  userAgent: 'Test/1.0',
};

function signupInput(overrides: Partial<typeof SIGNUP_DEFAULTS> = {}): typeof SIGNUP_DEFAULTS {
  return { ...SIGNUP_DEFAULTS, ...overrides };
}

function loginInput(
  overrides: Partial<{
    phone: string;
    otp: string;
    deviceId: string;
    deviceFingerprint: string;
    ipAddress: string;
    userAgent: string;
  }> = {},
) {
  return {
    phone: '+919000000001',
    otp: '123456',
    deviceId: 'dev-1',
    deviceFingerprint: 'fp-1',
    ipAddress: '127.0.0.1',
    userAgent: 'Test/1.0',
    ...overrides,
  };
}

class MockOtpService implements OtpService {
  send = vi.fn<(input: OtpSendInput) => Promise<void>>().mockResolvedValue(undefined);
  verify = vi.fn<(input: OtpVerifyInput) => Promise<void>>().mockResolvedValue(undefined);
}

type AnyModel = Model<Record<string, unknown>>;

// ---- Suite setup ----

beforeAll(async () => {
  await connectTestMongo();
  // Sync indexes so e.g. users.phone unique fires during signup tests.
  await Promise.all(Object.values(MODELS).map((m) => (m as unknown as AnyModel).syncIndexes()));
  __resetJwtKeysForTesting();
  await initJwtKeys();
}, 120_000);

afterAll(async () => {
  await disconnectTestMongo();
});

beforeEach(async () => {
  await clearAllCollections();
});

// ---- Phase 11.6 — verify-response shape lock-in ----

describe('AuthService.verifySignupOtp / verifyLoginOtp — Phase 11.6 minimal shape lock-in', () => {
  it('signup verify response carries only {id, phone, coinBalance, displayName?} — no tier-derived fields', async () => {
    const otp = new MockOtpService();
    const svc = new AuthService({ otpService: otp });
    const result = await svc.verifySignupOtp(signupInput());

    // Path B: /me is the canonical source for tier-derived UI.
    // Auth verify must NOT surface any of these or Flutter ends
    // up with two truth sources for the same UI state.
    expect(result.user).not.toHaveProperty('tier');
    expect(result.user).not.toHaveProperty('tierExpiresAt');
    expect(result.user).not.toHaveProperty('subscription');
    expect(result.user).not.toHaveProperty('subscriptions');
    expect(result.user).not.toHaveProperty('currentTier');
    expect(result.user).not.toHaveProperty('kyc');

    // Required positive fields:
    expect(typeof result.user.id).toBe('string');
    expect(result.user.phone).toBe('+919000000001');
    expect(typeof result.user.coinBalance).toBe('number');
  });

  it('login verify response carries only {id, phone, coinBalance, displayName?} — no tier-derived fields', async () => {
    const otp = new MockOtpService();
    const svc = new AuthService({ otpService: otp });
    await svc.verifySignupOtp(signupInput());

    const login = await svc.verifyLoginOtp(loginInput());
    expect(login.user).not.toHaveProperty('tier');
    expect(login.user).not.toHaveProperty('tierExpiresAt');
    expect(login.user).not.toHaveProperty('subscription');
    expect(login.user).not.toHaveProperty('subscriptions');
    expect(login.user).not.toHaveProperty('currentTier');
    expect(login.user).not.toHaveProperty('kyc');

    expect(typeof login.user.id).toBe('string');
    expect(login.user.phone).toBe('+919000000001');
    expect(typeof login.user.coinBalance).toBe('number');
  });
});

// ---- Signup ----

describe('AuthService.verifySignupOtp — happy path', () => {
  it('creates user, credits 3 coins atomically, issues tokens, upserts device fingerprint', async () => {
    const otp = new MockOtpService();
    const svc = new AuthService({ otpService: otp });

    const result = await svc.verifySignupOtp(signupInput());

    expect(result.user.phone).toBe('+919000000001');
    expect(result.user.coinBalance).toBe(3);
    expect(result.tokens.access).toBeTruthy();
    expect(result.tokens.refresh).toBeTruthy();
    expect(result.tokens.accessExpiresIn).toBe(900);

    const user = await UserModel.findOne({ phone: '+919000000001' });
    expect(user).toBeTruthy();
    expect(user?.coinBalance).toBe(3);
    expect(user?.signupBonusGranted).toBe(true);
    expect(user?.referralCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(user?.consentVersion).toBe('v1');

    const txs = await CoinTransactionModel.find({ userId: user?._id });
    expect(txs).toHaveLength(1);
    expect(txs[0]?.type).toBe('SIGNUP_BONUS');
    expect(txs[0]?.amount).toBe(3);
    expect(txs[0]?.balanceAfter).toBe(3);

    const device = await DeviceFingerprintModel.findOne({ fingerprint: 'fp-1' });
    expect(device).toBeTruthy();
    expect(device?.linkedUserIds).toHaveLength(1);

    const sessions = await LoginSessionModel.find({ userId: user?._id });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.revokedAt).toBeFalsy();
  });
});

describe('AuthService.verifySignupOtp — transaction rollback', () => {
  it('rolls back user + device + session when coin_transactions insert fails', async () => {
    const otp = new MockOtpService();
    const coinTxRepo = new CoinTransactionRepository();
    vi.spyOn(coinTxRepo, 'create').mockRejectedValue(new Error('simulated coin_tx failure'));
    const svc = new AuthService({ otpService: otp, coinTxRepo });

    await expect(svc.verifySignupOtp(signupInput())).rejects.toThrow(/simulated coin_tx failure/);

    expect(await UserModel.countDocuments({ phone: '+919000000001' })).toBe(0);
    expect(await DeviceFingerprintModel.countDocuments({ fingerprint: 'fp-1' })).toBe(0);
    expect(await CoinTransactionModel.countDocuments({})).toBe(0);
    expect(await LoginSessionModel.countDocuments({})).toBe(0);
  });
});

describe('AuthService.verifySignupOtp — referral', () => {
  it('resolving referralCode sets referredBy, no reward', async () => {
    const referrer = await UserModel.create({
      phone: '+919999999900',
      dob: new Date('1990-01-01'),
      declaredState: 'IN-MH',
      referralCode: 'ABCD1234',
      coinBalance: 0,
    });

    const otp = new MockOtpService();
    const svc = new AuthService({ otpService: otp });
    const result = await svc.verifySignupOtp(signupInput({ referralCode: 'ABCD1234' }));

    const newUser = await UserModel.findOne({ phone: '+919000000001' });
    expect(String(newUser?.referredBy)).toBe(String(referrer._id));
    expect(result.user.coinBalance).toBe(3); // referrer-reward not applied

    const refresh = await UserModel.findById(referrer._id);
    expect(refresh?.coinBalance).toBe(0); // referrer unchanged
  });

  it('unknown referralCode: signup still succeeds, referredBy unset', async () => {
    const otp = new MockOtpService();
    const svc = new AuthService({ otpService: otp });
    await svc.verifySignupOtp(signupInput({ referralCode: 'ZZZZ9999' }));

    const user = await UserModel.findOne({ phone: '+919000000001' });
    expect(user?.referredBy).toBeFalsy();
  });
});

describe('AuthService.verifySignupOtp — device fingerprint', () => {
  it('rejects with DEVICE_BLOCKED when fingerprint is linked to a blocked user', async () => {
    const blocked = await UserModel.create({
      phone: '+919999999901',
      dob: new Date('1990-01-01'),
      declaredState: 'IN-MH',
      blocked: { isBlocked: true, reason: 'test' },
    });
    await DeviceFingerprintModel.create({
      fingerprint: 'fp-shared',
      linkedUserIds: [blocked._id],
    });

    const otp = new MockOtpService();
    const svc = new AuthService({ otpService: otp });

    await expect(
      svc.verifySignupOtp(signupInput({ deviceFingerprint: 'fp-shared' })),
    ).rejects.toMatchObject({ code: 'DEVICE_BLOCKED' });

    expect(await UserModel.countDocuments({ phone: '+919000000001' })).toBe(0);
  });

  it('succeeds with suspiciousScore bump when fingerprint is linked to 3 existing users', async () => {
    const existing = await Promise.all(
      [1, 2, 3].map((i) =>
        UserModel.create({
          phone: `+91999999990${i}`,
          dob: new Date('1990-01-01'),
          declaredState: 'IN-MH',
        }),
      ),
    );
    await DeviceFingerprintModel.create({
      fingerprint: 'fp-multi',
      linkedUserIds: existing.map((u) => u._id),
    });

    const otp = new MockOtpService();
    const svc = new AuthService({ otpService: otp });
    const result = await svc.verifySignupOtp(signupInput({ deviceFingerprint: 'fp-multi' }));

    expect(result.user.phone).toBe('+919000000001');

    const device = await DeviceFingerprintModel.findOne({ fingerprint: 'fp-multi' });
    expect(device?.suspiciousScore).toBeGreaterThanOrEqual(10);
    expect(device?.linkedUserIds).toHaveLength(4);
    expect(device?.blocked).toBe(false);
  });
});

describe('AuthService.verifySignupOtp — uniqueness', () => {
  it('second signup with same phone returns PHONE_ALREADY_REGISTERED', async () => {
    const otp = new MockOtpService();
    const svc = new AuthService({ otpService: otp });

    await svc.verifySignupOtp(signupInput());
    await expect(svc.verifySignupOtp(signupInput())).rejects.toMatchObject({
      code: 'PHONE_ALREADY_REGISTERED',
    });
  });
});

describe('AuthService.verifySignupOtp — underage', () => {
  it('DOB under 18 is rejected with UNDERAGE', async () => {
    const otp = new MockOtpService();
    const svc = new AuthService({ otpService: otp });

    const dob17 = new Date();
    dob17.setFullYear(dob17.getFullYear() - 17);
    await expect(svc.verifySignupOtp(signupInput({ dob: dob17 }))).rejects.toMatchObject({
      code: 'UNDERAGE',
    });
  });
});

// ---- Enumeration defence ----

describe('AuthService.requestSignupOtp — enumeration defence', () => {
  it('returns success shape WITHOUT calling sender when phone is already registered', async () => {
    await UserModel.create({
      phone: '+919000000001',
      dob: new Date('1990-01-01'),
      declaredState: 'IN-MH',
    });

    const otp = new MockOtpService();
    const svc = new AuthService({ otpService: otp });

    const result = await svc.requestSignupOtp({
      phone: '+919000000001',
      deviceId: 'dev-1',
      deviceFingerprint: 'fp-1',
      ipAddress: '127.0.0.1',
    });

    expect(result.requestedAt).toBeInstanceOf(Date);
    expect(result.resendAllowedAt).toBeInstanceOf(Date);
    expect(otp.send).not.toHaveBeenCalled();
  });

  it('calls sender when phone is not registered', async () => {
    const otp = new MockOtpService();
    const svc = new AuthService({ otpService: otp });

    await svc.requestSignupOtp({
      phone: '+919000000002',
      deviceId: 'dev-2',
      deviceFingerprint: 'fp-2',
      ipAddress: '127.0.0.1',
    });

    expect(otp.send).toHaveBeenCalledOnce();
  });
});

describe('AuthService.requestLoginOtp — enumeration defence', () => {
  it('suppresses SMS for unknown phones and returns success shape', async () => {
    const otp = new MockOtpService();
    const svc = new AuthService({ otpService: otp });

    const result = await svc.requestLoginOtp({ phone: '+919999999944', ipAddress: '1.2.3.4' });
    expect(result.requestedAt).toBeInstanceOf(Date);
    expect(otp.send).not.toHaveBeenCalled();
  });
});

// ---- Login ----

describe('AuthService.verifyLoginOtp', () => {
  it('happy path: existing user gets a new session on top of their signup session', async () => {
    const otp = new MockOtpService();
    const svc = new AuthService({ otpService: otp });
    await svc.verifySignupOtp(signupInput());

    const login = await svc.verifyLoginOtp(loginInput());

    expect(login.user.phone).toBe('+919000000001');
    expect(login.tokens.access).toBeTruthy();

    const user = await UserModel.findOne({ phone: '+919000000001' });
    const sessions = await LoginSessionModel.find({ userId: user?._id });
    expect(sessions).toHaveLength(2);
  });
});

// ---- Refresh state machine ----

describe('AuthService.refresh — state machine', () => {
  it('Case A: active session + device match → old revoked, new session in same family', async () => {
    const otp = new MockOtpService();
    const svc = new AuthService({ otpService: otp });

    const signup = await svc.verifySignupOtp(signupInput());
    const rotated = await svc.refresh({
      refreshToken: signup.tokens.refresh,
      deviceId: 'dev-1',
      ipAddress: '127.0.0.1',
      userAgent: 'UA',
    });

    expect(rotated.access).toBeTruthy();
    expect(rotated.refresh).not.toBe(signup.tokens.refresh);

    const user = await UserModel.findOne({ phone: '+919000000001' });
    const sessions = await LoginSessionModel.find({ userId: user?._id }).sort({
      createdAt: 1,
    });
    expect(sessions).toHaveLength(2);
    expect(sessions[0]?.revokedAt).toBeTruthy();
    expect(sessions[1]?.revokedAt).toBeFalsy();
    expect(sessions[0]?.family).toBe(sessions[1]?.family);
  });

  it('Case B: device mismatch → 403 DEVICE_MISMATCH and entire family revoked', async () => {
    const otp = new MockOtpService();
    const svc = new AuthService({ otpService: otp });
    const signup = await svc.verifySignupOtp(signupInput({ deviceId: 'dev-A' }));

    await expect(
      svc.refresh({
        refreshToken: signup.tokens.refresh,
        deviceId: 'dev-WRONG',
        ipAddress: '127.0.0.1',
        userAgent: 'UA',
      }),
    ).rejects.toMatchObject({ code: 'DEVICE_MISMATCH' });

    const user = await UserModel.findOne({ phone: '+919000000001' });
    const sessions = await LoginSessionModel.find({ userId: user?._id });
    expect(sessions.every((s) => s.revokedAt)).toBe(true);
  });

  it('Case C: re-presenting an already-rotated token triggers family revoke + 401', async () => {
    const otp = new MockOtpService();
    const svc = new AuthService({ otpService: otp });
    const signup = await svc.verifySignupOtp(signupInput());
    const old = signup.tokens.refresh;

    // First rotation succeeds.
    await svc.refresh({
      refreshToken: old,
      deviceId: 'dev-1',
      ipAddress: '127.0.0.1',
      userAgent: 'UA',
    });

    // Re-presenting the old token: Case C reuse.
    await expect(
      svc.refresh({
        refreshToken: old,
        deviceId: 'dev-1',
        ipAddress: '127.0.0.1',
        userAgent: 'UA',
      }),
    ).rejects.toThrow(/Invalid or expired refresh token/);

    const user = await UserModel.findOne({ phone: '+919000000001' });
    const sessions = await LoginSessionModel.find({ userId: user?._id });
    expect(sessions.every((s) => s.revokedAt)).toBe(true);
  });

  it('Case D: unknown token (no family) → 401, no revocation', async () => {
    const otp = new MockOtpService();
    const svc = new AuthService({ otpService: otp });

    const phantom = await signRefreshToken({
      sub: new mongoose.Types.ObjectId().toString(),
      jti: 'phantom-jti',
      family: 'phantom-family',
      tokenVersion: 1,
    });

    await expect(
      svc.refresh({
        refreshToken: phantom,
        deviceId: 'dev-1',
        ipAddress: '127.0.0.1',
        userAgent: 'UA',
      }),
    ).rejects.toThrow(/Invalid or expired refresh token/);

    expect(await LoginSessionModel.countDocuments({})).toBe(0);
  });

  it('concurrency: two simultaneous refreshes with same token — exactly one succeeds', async () => {
    const otp = new MockOtpService();
    const svc = new AuthService({ otpService: otp });
    const signup = await svc.verifySignupOtp(signupInput());

    const refreshCall = () =>
      svc.refresh({
        refreshToken: signup.tokens.refresh,
        deviceId: 'dev-1',
        ipAddress: '127.0.0.1',
        userAgent: 'UA',
      });

    const [a, b] = await Promise.allSettled([refreshCall(), refreshCall()]);
    const fulfilled = [a, b].filter((r) => r.status === 'fulfilled');
    const rejected = [a, b].filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    // The loser triggered Case C → family-wide revoke. Every session
    // in the user's family should now be revoked, including the
    // winner's fresh session.
    const user = await UserModel.findOne({ phone: '+919000000001' });
    const sessions = await LoginSessionModel.find({ userId: user?._id });
    expect(sessions.length).toBeGreaterThanOrEqual(2);
    expect(sessions.every((s) => s.revokedAt)).toBe(true);
  });
});

// ---- Phase 11.5 — refresh-path tokenVersion enforcement ----

/**
 * §A12 acceptance: a force-logout via tokenVersion-bump must not be
 * bypass-able through a still-live refresh token whose access sibling
 * has expired. The four specs below lock the contract end-to-end:
 *  1. matching tokenVersion → success
 *  2. mismatched tokenVersion → 401 TOKEN_VERSION_MISMATCH
 *  3. pre-11.5 token (no claim → parses as 0) vs default User.tokenVersion=1
 *  4. post-bump scenario — proves the deploy-time cutoff sticks across
 *     access-expiry → refresh path (the actual force-logout flow).
 */
describe('AuthService.refresh — Phase 11.5 tokenVersion enforcement', () => {
  it('Spec 1: matching tokenVersion → rotates and returns new tokens', async () => {
    const otp = new MockOtpService();
    const svc = new AuthService({ otpService: otp });

    const signup = await svc.verifySignupOtp(signupInput());
    const issued = await verifyRefreshToken(signup.tokens.refresh);
    expect(issued.tokenVersion).toBe(1);

    const rotated = await svc.refresh({
      refreshToken: signup.tokens.refresh,
      deviceId: 'dev-1',
      ipAddress: '127.0.0.1',
      userAgent: 'UA',
    });

    expect(rotated.access).toBeTruthy();
    expect(rotated.refresh).not.toBe(signup.tokens.refresh);
    const newClaims = await verifyRefreshToken(rotated.refresh);
    expect(newClaims.tokenVersion).toBe(1);
  });

  it('Spec 2: mismatched tokenVersion → 401 TOKEN_VERSION_MISMATCH and family revoked', async () => {
    const otp = new MockOtpService();
    const svc = new AuthService({ otpService: otp });
    const signup = await svc.verifySignupOtp(signupInput());

    // Out-of-band: bump the User.tokenVersion to simulate a force-logout
    // since signup. The refresh token still carries tokenVersion=1.
    const user = await UserModel.findOne({ phone: '+919000000001' });
    await UserModel.updateOne({ _id: user?._id }, { $set: { tokenVersion: 7 } });

    await expect(
      svc.refresh({
        refreshToken: signup.tokens.refresh,
        deviceId: 'dev-1',
        ipAddress: '127.0.0.1',
        userAgent: 'UA',
      }),
    ).rejects.toMatchObject({ message: 'TOKEN_VERSION_MISMATCH' });

    // Family revoke — every session for this user dies, so the
    // attacker-or-stale-client cannot bounce on a sibling session.
    const sessions = await LoginSessionModel.find({ userId: user?._id });
    expect(sessions.every((s) => s.revokedAt)).toBe(true);
  });

  it('Spec 3: pre-11.5 token (no tokenVersion claim → parses as 0) → 401 against default User.tokenVersion=1', async () => {
    const otp = new MockOtpService();
    const svc = new AuthService({ otpService: otp });
    const signup = await svc.verifySignupOtp(signupInput());

    // Forge a pre-11.5-style token by signing with tokenVersion=0.
    // The verify path treats missing claim as 0 (signer.ts L162-163);
    // signing 0 explicitly is observationally identical and the only
    // way to construct one without bypassing the signer entirely.
    const session = await LoginSessionModel.findOne({});
    const user = await UserModel.findOne({ phone: '+919000000001' });
    expect(session?.family).toBeTruthy();
    expect(user?.tokenVersion).toBe(1);

    const preToken = await signRefreshToken({
      sub: String(user?._id),
      jti: session?.jti ?? 'jti-fallback',
      family: session?.family ?? 'fam-fallback',
      tokenVersion: 0,
    });

    // Replace the active session's hash so the lookup matches the
    // forged token (otherwise we'd hit Case D before tokenVersion).
    await LoginSessionModel.updateOne(
      { _id: session?._id },
      { $set: { refreshTokenHash: hashRefreshToken(preToken) } },
    );

    await expect(
      svc.refresh({
        refreshToken: preToken,
        deviceId: 'dev-1',
        ipAddress: '127.0.0.1',
        userAgent: 'UA',
      }),
    ).rejects.toMatchObject({ message: 'TOKEN_VERSION_MISMATCH' });

    // Use signup token to silence unused-var; sanity-check it carries v1.
    const issued = await verifyRefreshToken(signup.tokens.refresh);
    expect(issued.tokenVersion).toBe(1);
  });

  it('Spec 4: refresh AFTER runBumpTokenVersions → 401 even on a still-valid refresh token (force-logout sticks across access-expiry)', async () => {
    const otp = new MockOtpService();
    const svc = new AuthService({ otpService: otp });

    // User signs up → tokenVersion=1 baked into refresh token.
    const signup = await svc.verifySignupOtp(signupInput());
    const beforeClaims = await verifyRefreshToken(signup.tokens.refresh);
    expect(beforeClaims.tokenVersion).toBe(1);

    // Operator runs the deploy-time force-logout sweep. Every User
    // row's tokenVersion gets $inc'd by 1.
    const report = await runBumpTokenVersions();
    expect(report.matched).toBeGreaterThanOrEqual(1);
    expect(report.modified).toBeGreaterThanOrEqual(1);

    const userAfter = await UserModel.findOne({ phone: '+919000000001' });
    expect(userAfter?.tokenVersion).toBe(2);

    // Simulate the real-world scenario: access token has expired
    // naturally; client comes back to /refresh with the still-live
    // refresh token. Without the §A12 check this would mint a fresh
    // access pair — backdoor around the deploy cutoff.
    await expect(
      svc.refresh({
        refreshToken: signup.tokens.refresh,
        deviceId: 'dev-1',
        ipAddress: '127.0.0.1',
        userAgent: 'UA',
      }),
    ).rejects.toMatchObject({ message: 'TOKEN_VERSION_MISMATCH' });

    // Family revoked → the user must re-login from scratch, which
    // is the entire point of the bump-token-versions deploy step.
    const sessions = await LoginSessionModel.find({ userId: userAfter?._id });
    expect(sessions.every((s) => s.revokedAt)).toBe(true);
  });
});

// ---- Logout ----

describe('AuthService.logout', () => {
  it('revokes the single session for the refresh token; other family members stay active', async () => {
    const otp = new MockOtpService();
    const svc = new AuthService({ otpService: otp });

    const signupA = await svc.verifySignupOtp(
      signupInput({ deviceId: 'dev-A', deviceFingerprint: 'fp-A' }),
    );
    const loginB = await svc.verifyLoginOtp(
      loginInput({ deviceId: 'dev-B', deviceFingerprint: 'fp-B' }),
    );

    await svc.logout({ refreshToken: signupA.tokens.refresh, userId: signupA.user.id });

    const user = await UserModel.findOne({ phone: '+919000000001' });
    const sessA = await LoginSessionModel.findOne({
      userId: user?._id,
      refreshTokenHash: hashRefreshToken(signupA.tokens.refresh),
    });
    const sessB = await LoginSessionModel.findOne({
      userId: user?._id,
      refreshTokenHash: hashRefreshToken(loginB.tokens.refresh),
    });

    expect(sessA?.revokedAt).toBeTruthy();
    expect(sessB?.revokedAt).toBeFalsy();
  });
});

describe('AuthService.logoutAll', () => {
  it('revokes every active session for the user across all families', async () => {
    const otp = new MockOtpService();
    const svc = new AuthService({ otpService: otp });

    const signup = await svc.verifySignupOtp(
      signupInput({ deviceId: 'dev-A', deviceFingerprint: 'fp-A' }),
    );
    await svc.verifyLoginOtp(loginInput({ deviceId: 'dev-B', deviceFingerprint: 'fp-B' }));
    await svc.verifyLoginOtp(loginInput({ deviceId: 'dev-C', deviceFingerprint: 'fp-C' }));

    const result = await svc.logoutAll({ userId: signup.user.id });
    expect(result.revokedCount).toBe(3);

    const user = await UserModel.findOne({ phone: '+919000000001' });
    const sessions = await LoginSessionModel.find({ userId: user?._id });
    expect(sessions).toHaveLength(3);
    expect(sessions.every((s) => s.revokedAt)).toBe(true);
  });
});
