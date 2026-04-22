import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { NotFoundError } from '../../shared/errors/AppError.js';
import { requireAuthedUser } from '../../shared/middleware/auth.middleware.js';
import { requireContext } from '../../shared/middleware/requestContext.js';
import { ListPostsQuerySchema, PostIdParamsSchema } from './posts.schemas.js';
import type { PostService } from './posts.service.js';

/**
 * User-facing HTTP edge. Admin endpoints are intentionally absent in
 * Phase 3 — AdminPostService ships as a class only. Phase 8 wires
 * `posts.admin.controller.ts` + RBAC + audit-log middleware.
 */
export class PostController {
  constructor(private readonly svc: PostService) {}

  listByDate = async (req: Request, res: Response): Promise<void> => {
    const { date } = ListPostsQuerySchema.parse(req.query);
    const user = requireAuthedUser(req);
    const data = await this.svc.listForDate(date, new Types.ObjectId(user.sub), user.tier);
    res.json({ success: true, data });
  };

  getById = async (req: Request, res: Response): Promise<void> => {
    const { id } = PostIdParamsSchema.parse(req.params);
    const user = requireAuthedUser(req);
    const data = await this.svc.getById(
      new Types.ObjectId(id),
      new Types.ObjectId(user.sub),
      user.tier,
    );
    if (!data) throw new NotFoundError('Post not found');
    res.json({ success: true, data });
  };

  complete = async (req: Request, res: Response): Promise<void> => {
    const { id } = PostIdParamsSchema.parse(req.params);
    const user = requireAuthedUser(req);
    // Ensures requestContext middleware has populated req.context,
    // even though this handler doesn't consume its fields yet.
    // Future anti-fraud hooks will read ipAddress / deviceFingerprint
    // from req.context for fraud-score bumps.
    requireContext(req);
    const data = await this.svc.completePost({
      postId: new Types.ObjectId(id),
      userId: new Types.ObjectId(user.sub),
      userTier: user.tier,
    });
    res.json({ success: true, data });
  };
}
