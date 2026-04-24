import { Router, type RequestHandler } from 'express';
import { requireUser } from '../../shared/middleware/auth.middleware.js';
import { makeRateLimiter } from '../../shared/middleware/rateLimit.js';
import type { UserCoinsService } from './users.coins.service.js';
import { UsersController } from './users.controller.js';
import { UserErasureController } from './users.erasure.controller.js';
import { UserErasureService } from './users.erasure.service.js';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

/**
 * /me/* routes. Phase 3 scaffolding — currently exposes /me/coins
 * and /me/account/erasure (Phase 9 Chunk 4 — see docs/DPDP.md).
 * Other /me/* endpoints (profile GET/PATCH, KYC, sessions,
 * device-token) land in later phases.
 */
export function createUsersRouter(
  coinsService: UserCoinsService,
  erasureService: UserErasureService = new UserErasureService(),
): Router {
  const router = Router();
  const controller = new UsersController(coinsService);
  const erasureController = new UserErasureController(erasureService);

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

  router.get('/me/coins', requireUser, coinsLimiter, controller.listCoins);

  router.post('/me/account/erasure', requireUser, erasureLimiter, erasureController.request);
  router.delete('/me/account/erasure', requireUser, erasureLimiter, erasureController.cancel);
  router.get('/me/account/erasure', requireUser, erasureLimiter, erasureController.status);

  return router;
}
