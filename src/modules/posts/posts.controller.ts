import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { ForbiddenError, NotFoundError } from '../../shared/errors/AppError.js';
import { requireAuthedUser } from '../../shared/middleware/auth.middleware.js';
import { requireContext } from '../../shared/middleware/requestContext.js';
import { userCanAccessTier } from '../../shared/models/_tier.js';
import { UserRepository } from '../../shared/repositories/User.repository.js';
import { ListPostsQuerySchema, PostIdParamsSchema } from './posts.schemas.js';
import type { PostService } from './posts.service.js';

/**
 * User-facing HTTP edge for posts.
 *
 * Phase 11.4 — auth model is STRICT subscription-based. Each tier
 * section (PUBLIC / PRO / PRO_MAX) is independent: a PRO_MAX-only
 * subscriber does NOT have access to PRO content. The controller
 * fetches `user.subscriptions[]` and passes it to the service for
 * the access checks (`userCanAccessTier`). One extra DB read per
 * authed call; Phase 11.5 will optimize by carrying the
 * accessibleTiers set in the JWT claims.
 */
export class PostController {
  constructor(
    private readonly svc: PostService,
    private readonly userRepo: UserRepository = new UserRepository(),
  ) {}

  listByDate = async (req: Request, res: Response): Promise<void> => {
    const { date, tier } = ListPostsQuerySchema.parse(req.query);
    const claims = requireAuthedUser(req);
    const userId = new Types.ObjectId(claims.sub);
    const user = await this.userRepo.findById(userId);
    const subscriptions = user?.subscriptions ?? [];

    if (!userCanAccessTier(subscriptions, tier, new Date())) {
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
    const user = await this.userRepo.findById(userId);
    const data = await this.svc.getById(new Types.ObjectId(id), userId, user?.subscriptions ?? []);
    if (!data) throw new NotFoundError('Post not found');
    res.json({ success: true, data });
  };

  complete = async (req: Request, res: Response): Promise<void> => {
    const { id } = PostIdParamsSchema.parse(req.params);
    const claims = requireAuthedUser(req);
    const userId = new Types.ObjectId(claims.sub);
    requireContext(req);
    const user = await this.userRepo.findById(userId);
    const data = await this.svc.completePost({
      postId: new Types.ObjectId(id),
      userId,
      subscriptions: user?.subscriptions ?? [],
    });
    res.json({ success: true, data });
  };
}
