import { Router, type RequestHandler } from 'express';
import { requireUser } from '../../shared/middleware/auth.middleware.js';
import { makeRateLimiter } from '../../shared/middleware/rateLimit.js';
import { SubscriptionsController } from './subscriptions.controller.js';
import type { SubscriptionService } from './subscriptions.service.js';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

export function createSubscriptionsRouter(service: SubscriptionService): Router {
  const router = Router();
  const controller = new SubscriptionsController(service);

  const plansLimiter: RequestHandler = makeRateLimiter({
    name: 'sub_plans',
    windowMs: MIN,
    max: 60,
    keyKind: 'user',
  });
  const createLimiter: RequestHandler = makeRateLimiter({
    name: 'sub_create',
    windowMs: HOUR,
    max: 3,
    keyKind: 'user',
  });
  const verifyLimiter: RequestHandler = makeRateLimiter({
    name: 'sub_verify',
    windowMs: MIN,
    max: 10,
    keyKind: 'user',
  });
  const cancelLimiter: RequestHandler = makeRateLimiter({
    name: 'sub_cancel',
    windowMs: HOUR,
    max: 10,
    keyKind: 'user',
  });
  const readLimiter: RequestHandler = makeRateLimiter({
    name: 'sub_read',
    windowMs: MIN,
    max: 60,
    keyKind: 'user',
  });

  router.get('/subscriptions/plans', requireUser, plansLimiter, controller.listPlans);
  router.post('/subscriptions/create', requireUser, createLimiter, controller.create);
  router.post('/subscriptions/verify', requireUser, verifyLimiter, controller.verify);
  router.post('/subscriptions/:id/cancel', requireUser, cancelLimiter, controller.cancel);
  router.get('/subscriptions/mine', requireUser, readLimiter, controller.listMine);
  router.get('/subscriptions/:id/invoices', requireUser, readLimiter, controller.listInvoices);

  return router;
}
