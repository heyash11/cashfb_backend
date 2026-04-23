import { Router, type RequestHandler } from 'express';
import { makeRateLimiter } from '../../shared/middleware/rateLimit.js';
import { DonationsController } from './donations.controller.js';
import type { DonationService } from './donations.service.js';

const MIN = 60 * 1000;

/**
 * Public donation endpoints per API.md §5. Authenticated users
 * optionally — route does not require `requireUser`.
 */
export function createDonationsRouter(service: DonationService): Router {
  const router = Router();
  const controller = new DonationsController(service);

  const createOrderLimiter: RequestHandler = makeRateLimiter({
    name: 'donations_create_order',
    windowMs: MIN,
    max: 5,
    keyKind: 'ip',
  });

  const verifyLimiter: RequestHandler = makeRateLimiter({
    name: 'donations_verify',
    windowMs: MIN,
    max: 10,
    keyKind: 'ip',
  });

  const topDonorLimiter: RequestHandler = makeRateLimiter({
    name: 'donations_top_donor',
    windowMs: MIN,
    max: 120,
    keyKind: 'ip',
  });

  const topDonorsLimiter: RequestHandler = makeRateLimiter({
    name: 'donations_top_donors',
    windowMs: MIN,
    max: 60,
    keyKind: 'ip',
  });

  router.post('/donations/create-order', createOrderLimiter, controller.createOrder);
  router.post('/donations/verify', verifyLimiter, controller.verify);
  router.get('/top-donor', topDonorLimiter, controller.getTopDonor);
  router.get('/top-donors', topDonorsLimiter, controller.listTopDonors);

  return router;
}
