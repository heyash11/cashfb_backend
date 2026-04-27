import { Router, type RequestHandler } from 'express';
import { requireUser } from '../../shared/middleware/auth.middleware.js';
import { makeRateLimiter } from '../../shared/middleware/rateLimit.js';
import { PrizePoolsController } from './prize-pools.controller.js';
import type { PrizePoolService } from './prize-pools.service.js';

const MIN = 60 * 1000;

export function createPrizePoolsRouter(svc: PrizePoolService): Router {
  const router = Router();
  const controller = new PrizePoolsController(svc);

  const todayLimiter: RequestHandler = makeRateLimiter({
    name: 'prize_pools_today',
    windowMs: MIN,
    max: 60,
    keyKind: 'user',
  });

  router.get('/prize-pools/today', requireUser, todayLimiter, controller.today);

  return router;
}
