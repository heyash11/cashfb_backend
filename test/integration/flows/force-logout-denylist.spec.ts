import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../../src/app.js';
import { redis } from '../../../src/config/redis.js';
import { AuthService } from '../../../src/modules/auth/auth.service.js';
import { OtpServiceImpl } from '../../../src/modules/auth/otp.service.js';
import type { OtpPurpose, OtpSender } from '../../../src/modules/auth/otp.types.js';
import { RedisLockoutStore } from '../../../src/modules/auth/lockout.store.js';
import { initJwtKeys, verifyAccessToken } from '../../../src/shared/jwt/signer.js';
import { LoginSessionModel } from '../../../src/shared/models/LoginSession.model.js';
import { forceLogoutStore } from '../../../src/shared/services/force-logout.js';
import { seedAdminSession } from '../../testing/admin-session-seed.js';
import { connectHarness, disconnectHarness, resetFullState } from './_harness.js';

/**
 * Integration — force-logout denylist end-to-end. Chunk 3a's most
 * security-sensitive surface: admin "sign me out everywhere" must
 * invalidate BOTH still-held access tokens (via requireUser
 * middleware's Redis cutoff check) AND still-held refresh tokens
 * (via AuthService.refresh's pre-rotation cutoff check, which also
 * revokes the entire rotation family so a racing refresh cannot
 * mint a fresh pair).
 *
 * This spec exercises:
 *   - real user signup + token issuance (AuthService against real Mongo)
 *   - admin HTTP force-logout via the full middleware chain
 *     (ipAllowlist → adminSession → csrfCheck → requireAnyRole →
 *     auditLog → service → Redis cutoff write)
 *   - user-side access token rejection (forceLogoutStore +
 *     verifyAccessToken — what requireUser does)
 *   - user-side refresh rejection with family revoke (AuthService)
 *   - LoginSession invariant: active-session count for that user
 *     drops to 0 after the family-wide revoke.
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

describe('[integration] force-logout denylist', () => {
  const app = createApp();

  it('admin force-logout → access token rejected, refresh rejected + family revoked, active sessions = 0', async () => {
    const sender = new CapturingOtpSender();
    const lockout = new RedisLockoutStore(redis);
    const otpService = new OtpServiceImpl({ sender, lockoutStore: lockout });
    const auth = new AuthService({ otpService });

    const phone = '+919000088888';
    const deviceId = 'integration-dev-force-logout';
    const deviceFingerprint = 'integration-fp-force-logout';
    const ipAddress = '127.0.0.1';
    const userAgent = 'integration-ua';

    // 1. User signs up and gets access + refresh tokens.
    await auth.requestSignupOtp({ phone, deviceId, deviceFingerprint, ipAddress });
    const otp = sender.latest.get(phone);
    if (!otp) throw new Error('OTP not captured');

    const signup = await auth.verifySignupOtp({
      phone,
      otp,
      deviceId,
      deviceFingerprint,
      ipAddress,
      userAgent,
      dob: new Date('1998-01-01'),
      declaredState: 'IN-MH',
      referralCode: undefined,
      consentVersion: '1',
      consentAcceptedAt: new Date(),
      privacyPolicyVersion: '1',
    });
    const userId = signup.user.id;
    const accessToken = signup.tokens.access;
    const refreshToken = signup.tokens.refresh;

    // Sanity: session row exists, active (revokedAt unset).
    const sessionsBefore = await LoginSessionModel.countDocuments({
      userId,
      revokedAt: { $exists: false },
    });
    expect(sessionsBefore).toBe(1);

    // Access token is valid + not force-logged-out (baseline).
    const claimsBefore = await verifyAccessToken(accessToken);
    expect(claimsBefore.sub).toBe(userId);
    await expect(
      forceLogoutStore.assertNotForceLoggedOut(claimsBefore.sub, claimsBefore.iat),
    ).resolves.toBeUndefined();

    // Force-logout wants `iat` to be <= cutoff. The signer uses
    // second-granularity `iat`; sleep 1.1s so the admin cutoff
    // (now() at force-logout time) is strictly greater than the
    // token's iat — otherwise equal-second timing is already
    // covered by the <= comparator but we want room for clocks to
    // drift by sub-second.
    await new Promise((r) => setTimeout(r, 1100));

    // 2. Admin force-logs-out the user via the real HTTP surface.
    const adminSeed = await seedAdminSession({ role: 'SUPER_ADMIN' });
    const res = await request(app)
      .post(`/api/v1/admin/users/${userId}/force-logout`)
      .set('Cookie', adminSeed.cookieHeader)
      .set(adminSeed.csrfHeaderName, adminSeed.csrfToken)
      .send({ reason: 'integration test: forced revocation' });
    expect(res.status).toBe(200);

    // 3. requireUser equivalent: cutoff is set; token's iat <= cutoff
    //    → UnauthorizedError "Session forcibly terminated".
    await expect(
      forceLogoutStore.assertNotForceLoggedOut(claimsBefore.sub, claimsBefore.iat),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED', httpStatus: 401 });

    // 4. Refresh with the still-held refresh token fails + family
    //    is revoked. This is the critical Chunk 3a guarantee — a
    //    user whose access token just expired must not be able to
    //    bounce back on a still-live refresh after force-logout.
    await expect(
      auth.refresh({ refreshToken, deviceId, ipAddress, userAgent }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED', httpStatus: 401 });

    // 5. Active session count for that user = 0 (family revoked).
    const activeAfter = await LoginSessionModel.countDocuments({
      userId,
      revokedAt: { $exists: false },
    });
    expect(activeAfter).toBe(0);

    const revokedAll = await LoginSessionModel.countDocuments({
      userId,
      revokedAt: { $exists: true },
    });
    expect(revokedAll).toBe(1);
  });
});
