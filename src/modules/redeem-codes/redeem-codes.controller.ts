import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { requireAuthedUser } from '../../shared/middleware/auth.middleware.js';
import type { RedeemCodeService } from './redeem-codes.service.js';
import { CodeIdParamsSchema, PostIdParamsSchema } from './redeem-codes.schemas.js';

/**
 * HTTP edge for `/posts/:id/redeem-codes`, `/redeem-codes/:id/copy`,
 * and `/redeem-codes/:id/mark-claimed`. Admin endpoints land in
 * Phase 8.
 *
 * Phase 11.5 — tier scoping is implicit via the post-completion
 * gate in the service: a user only sees codes for posts they
 * completed, and post completion was tier-auth-gated upstream
 * (Phase 11.4 strict-subscription model). No explicit tier
 * parameter needed at this layer.
 */
export class RedeemCodesController {
  constructor(private readonly service: RedeemCodeService) {}

  listForPost = async (req: Request, res: Response): Promise<void> => {
    const { id: postId } = PostIdParamsSchema.parse(req.params);
    const authed = requireAuthedUser(req);
    const userId = new Types.ObjectId(authed.sub);
    const items = await this.service.listForPost({ postId, userId });
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
