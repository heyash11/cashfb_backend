import { Router, type Request, type RequestHandler } from 'express';
import { env } from '../../config/env.js';
import { requireUser } from '../../shared/middleware/auth.middleware.js';
import { makeRateLimiter } from '../../shared/middleware/rateLimit.js';
import { validateBody } from '../../shared/middleware/validate.js';
import { AuthController } from './auth.controller.js';
import type { AuthService } from './auth.service.js';
import {
  LogoutBodySchema,
  RefreshBodySchema,
  RequestLoginOtpBodySchema,
  RequestSignupOtpBodySchema,
  VerifyLoginOtpBodySchema,
  VerifySignupOtpBodySchema,
} from './auth.schemas.js';

/**
 * Phase 9 Chunk 5 — rate-limit skip for load-test signup flows.
 * Triple-gated: dev mode + reserved load-test phone prefix + the
 * _devBypassOtp body flag. Production refuses to skip regardless
 * of phone pattern.
 *
 * Applied to the two OTP limiters that a 100-user load-test seed
 * would otherwise trip: `otp_request` (3/phone/10min — 100 distinct
 * phones are fine actually, but included for symmetry) and
 * `otp_verify` (10/IP/15min — the real bottleneck because all
 * seed calls come from 127.0.0.1).
 */
const LOAD_TEST_PHONE_PATTERN = /^\+919999990\d{3}$/;
function skipForLoadTest(req: Request): boolean {
  if (env.NODE_ENV !== 'development') return false;
  const body = req.body as { phone?: unknown; _devBypassOtp?: unknown } | undefined;
  if (body?._devBypassOtp !== true) return false;
  if (typeof body.phone !== 'string') return false;
  return LOAD_TEST_PHONE_PATTERN.test(body.phone);
}

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

/**
 * Rate-limit budgets per docs/API.md §1 and docs/SECURITY.md §1.
 *
 * OTP request: 3 per phone per 10 min. Phone-keyed is the primary
 * anti-abuse gate; an attacker changing IP cannot bypass it.
 *
 * OTP verify: 10 per IP per 15 min. IP-keyed layered gate. SECURITY.md
 * §1 also calls for a phone-lockout after 3 failed verifications,
 * which lands in Chunk 3's OtpService (Redis key otp:lockout:<phone>).
 *
 * Refresh: 30 per IP per min. Generous — legitimate clients rotate
 * often during active sessions.
 *
 * Logout: 10 per authed user per min.
 * Logout-all: 5 per authed user per hour. Rare operation.
 */
export function createAuthRouter(svc: AuthService): Router {
  const router = Router();
  const controller = new AuthController(svc);

  const otpRequestLimiter: RequestHandler = makeRateLimiter({
    name: 'otp_request',
    windowMs: 10 * MIN,
    max: 3,
    keyKind: 'phone',
    skip: skipForLoadTest,
  });
  const otpVerifyLimiter: RequestHandler = makeRateLimiter({
    name: 'otp_verify',
    windowMs: 15 * MIN,
    max: 10,
    keyKind: 'ip',
    skip: skipForLoadTest,
  });
  const refreshLimiter: RequestHandler = makeRateLimiter({
    name: 'auth_refresh',
    windowMs: MIN,
    max: 30,
    keyKind: 'ip',
  });
  const logoutLimiter: RequestHandler = makeRateLimiter({
    name: 'auth_logout',
    windowMs: MIN,
    max: 10,
    keyKind: 'user',
  });
  const logoutAllLimiter: RequestHandler = makeRateLimiter({
    name: 'auth_logout_all',
    windowMs: HOUR,
    max: 5,
    keyKind: 'user',
  });

  // Public (signup + login + refresh).
  router.post(
    '/signup/request-otp',
    otpRequestLimiter,
    validateBody(RequestSignupOtpBodySchema),
    controller.requestSignupOtp,
  );
  router.post(
    '/signup/verify',
    otpVerifyLimiter,
    validateBody(VerifySignupOtpBodySchema),
    controller.verifySignupOtp,
  );
  router.post(
    '/login/request-otp',
    otpRequestLimiter,
    validateBody(RequestLoginOtpBodySchema),
    controller.requestLoginOtp,
  );
  router.post(
    '/login/verify',
    otpVerifyLimiter,
    validateBody(VerifyLoginOtpBodySchema),
    controller.verifyLoginOtp,
  );
  router.post('/refresh', refreshLimiter, validateBody(RefreshBodySchema), controller.refresh);

  // Authed. `requireUser` runs before the user-keyed rate limiter so
  // the limiter can extract `req.user.sub` as its key.
  router.post(
    '/logout',
    requireUser,
    logoutLimiter,
    validateBody(LogoutBodySchema),
    controller.logout,
  );
  router.post('/logout-all', requireUser, logoutAllLimiter, controller.logoutAll);

  return router;
}
