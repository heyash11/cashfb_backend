import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { ForbiddenError, NotFoundError } from '../../shared/errors/AppError.js';
import { requireAuthedUser } from '../../shared/middleware/auth.middleware.js';
import { requireContext } from '../../shared/middleware/requestContext.js';
import { userCanAccessTier } from '../../shared/models/_tier.js';
import { ListPostsQuerySchema, PostIdParamsSchema } from './posts.schemas.js';
import type { PostService } from './posts.service.js';

/**
 * User-facing HTTP edge for posts.
 *
 * Phase 11.5 — auth middleware (`requireUser`) attaches
 * `subscriptions[]` to `req.user`. Controllers read from there
 * directly; no duplicate User fetch.
 */
export class PostController {
  constructor(private readonly svc: PostService) {}

  listByDate = async (req: Request, res: Response): Promise<void> => {
    const { date, tier } = ListPostsQuerySchema.parse(req.query);
    const claims = requireAuthedUser(req);
    const userId = new Types.ObjectId(claims.sub);

    if (!userCanAccessTier(claims.subscriptions, tier, new Date())) {
      throw new ForbiddenError(
        'TIER_NOT_ACCESSIBLE',
        `Subscription required to view ${tier} posts`,
      );
    }

    const data = await this.svc.listForDate(date, userId, tier);
    res.json({ success: true, data });
  };

  getById = async (req: Request, res: Response): Promise<void> => {
    const { id } = PostIdParamsSchema.parse(req.params);
    const claims = requireAuthedUser(req);
    const userId = new Types.ObjectId(claims.sub);
    const data = await this.svc.getById(new Types.ObjectId(id), userId, claims.subscriptions);
    if (!data) throw new NotFoundError('Post not found');
    res.json({ success: true, data });
  };

  complete = async (req: Request, res: Response): Promise<void> => {
    const { id } = PostIdParamsSchema.parse(req.params);
    const claims = requireAuthedUser(req);
    const userId = new Types.ObjectId(claims.sub);
    requireContext(req);
    const data = await this.svc.completePost({
      postId: new Types.ObjectId(id),
      userId,
      subscriptions: claims.subscriptions,
    });
    res.json({ success: true, data });
  };
}
