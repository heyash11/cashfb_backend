import { Router, type RequestHandler } from 'express';
import { requireUser } from '../../shared/middleware/auth.middleware.js';
import { makeRateLimiter } from '../../shared/middleware/rateLimit.js';
import type { UserCoinsService } from './users.coins.service.js';
import { UsersController } from './users.controller.js';

const MIN = 60 * 1000;

/**
 * /me/* routes. Phase 3 scaffolding — currently exposes /me/coins
 * only. Other /me/* endpoints (profile GET/PATCH, KYC, sessions,
 * device-token) land in later phases.
 */
export function createUsersRouter(coinsService: UserCoinsService): Router {
  const router = Router();
  const controller = new UsersController(coinsService);

  const coinsLimiter: RequestHandler = makeRateLimiter({
    name: 'me_coins',
    windowMs: MIN,
    max: 60,
    keyKind: 'user',
  });

  router.get('/me/coins', requireUser, coinsLimiter, controller.listCoins);

  return router;
}
