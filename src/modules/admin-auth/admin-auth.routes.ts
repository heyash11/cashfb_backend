import { Router, type RequestHandler } from 'express';
import { makeRateLimiter } from '../../shared/middleware/rateLimit.js';
import { adminSession } from '../../shared/middleware/admin-session.js';
import { csrfCheck } from '../../shared/middleware/csrf.js';
import { AdminAuthController } from './admin-auth.controller.js';
import type { AdminAuthService } from './admin-auth.service.js';

const MIN = 60 * 1000;

/**
 * Admin auth routes. Mounted at /api/v1/admin/auth/*.
 *
 * Middleware invariant: all writes require CSRF (adminSession +
 * csrfCheck). Only POST /login is exempt because no session exists
 * yet to carry a CSRF token; rate-limit + (at the parent mount)
 * ipAllowlist are the gates at that point.
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
  router.post('/logout', logoutLimiter, adminSession(), csrfCheck(), controller.logout);
  router.get('/me', meLimiter, adminSession(), controller.me);
  router.post('/csrf-rotate', meLimiter, adminSession(), csrfCheck(), controller.rotateCsrf);

  return router;
}
