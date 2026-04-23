import { Router, type RequestHandler } from 'express';
import { requireUser } from '../../shared/middleware/auth.middleware.js';
import { makeRateLimiter } from '../../shared/middleware/rateLimit.js';
import { RedeemCodesController } from './redeem-codes.controller.js';
import type { RedeemCodeService } from './redeem-codes.service.js';

const MIN = 60 * 1000;

/**
 * Phase 4 Chunk 2 scaffolding. Mounts the three user-facing redeem-
 * code endpoints. Admin endpoints (upload, publish, void, list,
 * audit export) land in Phase 8 with the full admin HTTP surface.
 */
export function createRedeemCodesRouter(service: RedeemCodeService): Router {
  const router = Router();
  const controller = new RedeemCodesController(service);

  const listLimiter: RequestHandler = makeRateLimiter({
    name: 'redeem_list_for_post',
    windowMs: MIN,
    max: 60,
    keyKind: 'user',
  });

  const claimLimiter: RequestHandler = makeRateLimiter({
    name: 'redeem_claim',
    windowMs: MIN,
    max: 30,
    keyKind: 'user',
  });

  const markClaimedLimiter: RequestHandler = makeRateLimiter({
    name: 'redeem_mark_claimed',
    windowMs: MIN,
    max: 30,
    keyKind: 'user',
  });

  router.get('/posts/:id/redeem-codes', requireUser, listLimiter, controller.listForPost);
  router.post('/redeem-codes/:id/copy', requireUser, claimLimiter, controller.claim);
  router.post(
    '/redeem-codes/:id/mark-claimed',
    requireUser,
    markClaimedLimiter,
    controller.markClaimed,
  );

  return router;
}
