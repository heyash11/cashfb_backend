import { Router, type RequestHandler } from 'express';
import { requireUser } from '../../shared/middleware/auth.middleware.js';
import { makeRateLimiter } from '../../shared/middleware/rateLimit.js';
import type { UserCoinsService } from './users.coins.service.js';
import { UsersController } from './users.controller.js';
import { UserErasureController } from './users.erasure.controller.js';
import { UserErasureService } from './users.erasure.service.js';
import { UserProfileService } from './users.profile.service.js';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

/**
 * /me/* routes. Currently exposes:
 *   GET /me                  — identity hydration (Phase 9.6)
 *   GET /me/coins            — coin transaction history (Phase 3)
 *   POST/DELETE/GET /me/account/erasure — DPDP erasure (Phase 9 Chunk 4 — see docs/DPDP.md)
 * Other /me/* endpoints (profile PATCH, KYC, sessions, device-token)
 * land in later phases.
 */
export function createUsersRouter(
  coinsService: UserCoinsService,
  profileService: UserProfileService = new UserProfileService(),
  erasureService: UserErasureService = new UserErasureService(),
): Router {
  const router = Router();
  const controller = new UsersController(coinsService, profileService);
  const erasureController = new UserErasureController(erasureService);

  // Mirror /me/coins limiter posture: 60 req/min/user — generous
  // enough for app pull-to-refresh + token-rotation hydration cycles
  // without inviting abuse. Same windowMs + keyKind, distinct `name`
  // so the Redis bucket is independent.
  const profileLimiter: RequestHandler = makeRateLimiter({
    name: 'me_profile',
    windowMs: MIN,
    max: 60,
    keyKind: 'user',
  });

  const coinsLimiter: RequestHandler = makeRateLimiter({
    name: 'me_coins',
    windowMs: MIN,
    max: 60,
    keyKind: 'user',
  });

  // Erasure is rare and high-impact. Per-user cap: 5 requests per
  // hour covers thinking-out-loud + cancel cycles without allowing
  // automated abuse.
  const erasureLimiter: RequestHandler = makeRateLimiter({
    name: 'me_erasure',
    windowMs: HOUR,
    max: 5,
    keyKind: 'user',
  });

  router.get('/me', requireUser, profileLimiter, controller.getMe);
  router.get('/me/coins', requireUser, coinsLimiter, controller.listCoins);

  router.post('/me/account/erasure', requireUser, erasureLimiter, erasureController.request);
  router.delete('/me/account/erasure', requireUser, erasureLimiter, erasureController.cancel);
  router.get('/me/account/erasure', requireUser, erasureLimiter, erasureController.status);

  return router;
}
