import http from 'k6/http';
import { check } from 'k6';

/**
 * Phase 9 Chunk 5 — shared k6 setup module. Signs up N synthetic
 * load-test users via the dev-mode OTP bypass (triply-gated in
 * AuthService: NODE_ENV=development + phone pattern + _devBypassOtp).
 *
 * Returns an array of `{userId, access, refresh, phone}` tuples the
 * per-script setup() passes into VU iterations.
 *
 * Load-test phone prefix: `+91 9999 990 NNN` (`+919999990NNN` —
 * zero-padded 3-digit suffix). 1000 reserved addresses; scripts use
 * indices 0..99.
 *
 * Runs sequentially — 100 signups at ~50ms each = ~5s setup cost.
 * That's acceptable for dev-loop load tests; k6's setup runs once
 * per `k6 run`, not per iteration.
 */

export const LOAD_PHONE_PREFIX = '+919999990';
const TARGET = __ENV.K6_TARGET || 'http://localhost:4000';

/**
 * Generate the load-test phone for a given index (0..999). Pads to
 * 3 digits so the fill order is deterministic + the pattern regex
 * stays tight.
 */
export function loadPhoneFor(index) {
  const suffix = String(index).padStart(3, '0');
  return `${LOAD_PHONE_PREFIX}${suffix}`;
}

/**
 * Sign up `count` users and return their tokens. Each user gets a
 * unique deviceFingerprint so the anti-fraud gate doesn't fire. The
 * auth server's dev-mode bypass accepts any 6-digit OTP when
 * _devBypassOtp:true is set, so we don't need to capture anything
 * out-of-band.
 */
export function seedUsers(count) {
  const users = [];
  for (let i = 0; i < count; i++) {
    const phone = loadPhoneFor(i);
    const deviceId = `k6-dev-${i}`;
    const deviceFingerprint = `k6-fp-${i}`;

    // Request the OTP. Needed so the OTP record exists — even
    // though the bypass skips verify, the request path is the same
    // as the real flow (plus it exercises rate-limit storage).
    const reqRes = http.post(
      `${TARGET}/api/v1/auth/signup/request-otp`,
      JSON.stringify({ phone, deviceId, deviceFingerprint, _devBypassOtp: true }),
      { headers: { 'Content-Type': 'application/json' } },
    );
    check(reqRes, { 'signup request-otp 200': (r) => r.status === 200 });

    const verifyRes = http.post(
      `${TARGET}/api/v1/auth/signup/verify`,
      JSON.stringify({
        phone,
        otp: '000000',
        dob: '1995-01-01',
        declaredState: 'IN-MH',
        consentVersion: '1',
        consentAcceptedAt: new Date().toISOString(),
        privacyPolicyVersion: '1',
        deviceId,
        deviceFingerprint,
        _devBypassOtp: true,
      }),
      { headers: { 'Content-Type': 'application/json' } },
    );
    const ok = check(verifyRes, {
      'signup verify 200': (r) => r.status === 200,
    });
    if (!ok) {
      throw new Error(
        `seed-users: signup verify failed for ${phone} (status ${verifyRes.status}): ${verifyRes.body}`,
      );
    }

    const body = verifyRes.json();
    users.push({
      userId: body.data.user.id,
      phone,
      access: body.data.tokens.access,
      refresh: body.data.tokens.refresh,
    });
  }
  return users;
}
