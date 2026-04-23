import { Router, type RequestHandler } from 'express';
import { makeRateLimiter } from '../../shared/middleware/rateLimit.js';
import { adminSession } from '../../shared/middleware/admin-session.js';
import { AdminAuthController } from './admin-auth.controller.js';
import type { AdminAuthService } from './admin-auth.service.js';

const MIN = 60 * 1000;

/**
 * Admin auth routes. Mounted at /api/v1/admin/auth/*. `POST /login`
 * and `POST /logout` intentionally do NOT run the full admin
 * middleware chain:
 *   - login: no session exists yet; IP allowlist + rate-limit are
 *     the only gates at this point.
 *   - logout: needs a valid session to know what to destroy, but
 *     skips CSRF (the purpose IS to destroy the session).
 *
 * Full-chain routes (every other admin endpoint) are mounted
 * elsewhere at /api/v1/admin/* behind the complete stack.
 */
export function createAdminAuthRouter(service: AdminAuthService): Router {
  const router = Router();
  const controller = new AdminAuthController(service);

  const loginLimiter: RequestHandler = makeRateLimiter({
    name: 'admin_login',
    windowMs: MIN,
    max: 10,
    keyKind: 'ip',
  });
  const logoutLimiter: RequestHandler = makeRateLimiter({
    name: 'admin_logout',
    windowMs: MIN,
    max: 30,
    keyKind: 'ip',
  });
  const meLimiter: RequestHandler = makeRateLimiter({
    name: 'admin_me',
    windowMs: MIN,
    max: 60,
    keyKind: 'ip',
  });

  router.post('/login', loginLimiter, controller.login);
  router.post('/logout', logoutLimiter, adminSession(), controller.logout);
  router.get('/me', meLimiter, adminSession(), controller.me);
  router.post('/csrf-rotate', meLimiter, adminSession(), controller.rotateCsrf);

  return router;
}
