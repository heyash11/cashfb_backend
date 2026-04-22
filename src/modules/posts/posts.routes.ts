import { Router, type RequestHandler } from 'express';
import { requireUser } from '../../shared/middleware/auth.middleware.js';
import { makeRateLimiter } from '../../shared/middleware/rateLimit.js';
import { PostController } from './posts.controller.js';
import type { PostService } from './posts.service.js';

const MIN = 60 * 1000;

/**
 * User-facing post routes. Rate limits user-keyed per Phase 3 plan.
 * `requireUser` runs BEFORE each limiter so the limiter can extract
 * `req.user.sub` as its key.
 */
export function createPostsRouter(svc: PostService): Router {
  const router = Router();
  const controller = new PostController(svc);

  const listLimiter: RequestHandler = makeRateLimiter({
    name: 'posts_list',
    windowMs: MIN,
    max: 60,
    keyKind: 'user',
  });
  const detailLimiter: RequestHandler = makeRateLimiter({
    name: 'posts_detail',
    windowMs: MIN,
    max: 120,
    keyKind: 'user',
  });
  const completeLimiter: RequestHandler = makeRateLimiter({
    name: 'posts_complete',
    windowMs: MIN,
    max: 60,
    keyKind: 'user',
  });

  router.get('/posts', requireUser, listLimiter, controller.listByDate);
  router.get('/posts/:id', requireUser, detailLimiter, controller.getById);
  router.post('/posts/:id/complete', requireUser, completeLimiter, controller.complete);

  return router;
}
