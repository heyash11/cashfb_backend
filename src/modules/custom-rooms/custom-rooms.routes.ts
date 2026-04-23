import { Router, type RequestHandler } from 'express';
import { requireUser } from '../../shared/middleware/auth.middleware.js';
import { makeRateLimiter } from '../../shared/middleware/rateLimit.js';
import { CustomRoomsController } from './custom-rooms.controller.js';
import type { CustomRoomsService } from './custom-rooms.service.js';

const MIN = 60 * 1000;

export function createCustomRoomsRouter(service: CustomRoomsService): Router {
  const router = Router();
  const controller = new CustomRoomsController(service);

  const listLimiter: RequestHandler = makeRateLimiter({
    name: 'custom_rooms_list',
    windowMs: MIN,
    max: 60,
    keyKind: 'user',
  });
  const registerLimiter: RequestHandler = makeRateLimiter({
    name: 'custom_rooms_register',
    windowMs: MIN,
    max: 10,
    keyKind: 'user',
  });
  const resultLimiter: RequestHandler = makeRateLimiter({
    name: 'custom_rooms_result',
    windowMs: MIN,
    max: 60,
    keyKind: 'user',
  });

  router.get('/custom-rooms', requireUser, listLimiter, controller.list);
  router.post('/custom-rooms/:id/register', requireUser, registerLimiter, controller.register);
  router.get('/custom-rooms/:id/result', requireUser, resultLimiter, controller.getResult);

  return router;
}
