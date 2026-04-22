import { Router, type RequestHandler } from 'express';
import { requireUser } from '../../shared/middleware/auth.middleware.js';
import { makeRateLimiter } from '../../shared/middleware/rateLimit.js';
import { VoteController } from './votes.controller.js';
import type { VoteService } from './votes.service.js';

const MIN = 60 * 1000;

export function createVotesRouter(svc: VoteService): Router {
  const router = Router();
  const controller = new VoteController(svc);

  const castLimiter: RequestHandler = makeRateLimiter({
    name: 'votes_cast',
    windowMs: MIN,
    max: 10,
    keyKind: 'user',
  });
  const todayLimiter: RequestHandler = makeRateLimiter({
    name: 'votes_today',
    windowMs: MIN,
    max: 60,
    keyKind: 'user',
  });

  router.get('/votes/today', requireUser, todayLimiter, controller.today);
  router.post('/votes', requireUser, castLimiter, controller.cast);

  return router;
}
