import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { requireAuthedUser } from '../../shared/middleware/auth.middleware.js';
import { UserRepository } from '../../shared/repositories/User.repository.js';
import type { RedeemCodeService } from './redeem-codes.service.js';
import { CodeIdParamsSchema, PostIdParamsSchema } from './redeem-codes.schemas.js';

/**
 * HTTP edge for `/posts/:id/redeem-codes`, `/redeem-codes/:id/copy`,
 * and `/redeem-codes/:id/mark-claimed`. Admin endpoints land in
 * Phase 8.
 */
export class RedeemCodesController {
  constructor(
    private readonly service: RedeemCodeService,
    private readonly userRepo: UserRepository = new UserRepository(),
  ) {}

  listForPost = async (req: Request, res: Response): Promise<void> => {
    const { id: postId } = PostIdParamsSchema.parse(req.params);
    const authed = requireAuthedUser(req);
    const userId = new Types.ObjectId(authed.sub);
    const user = await this.userRepo.findById(userId);
    const items = await this.service.listForPost({
      postId,
      userId,
      userTier: user?.tier ?? 'PUBLIC',
    });
    res.json({ success: true, data: { items } });
  };

  claim = async (req: Request, res: Response): Promise<void> => {
    const { id: codeId } = CodeIdParamsSchema.parse(req.params);
    const authed = requireAuthedUser(req);
    const result = await this.service.claim(codeId, new Types.ObjectId(authed.sub));
    res.json({ success: true, data: result });
  };

  markClaimed = async (req: Request, res: Response): Promise<void> => {
    const { id: codeId } = CodeIdParamsSchema.parse(req.params);
    const authed = requireAuthedUser(req);
    await this.service.markClaimed(codeId, new Types.ObjectId(authed.sub));
    res.json({ success: true, data: { ok: true } });
  };
}
