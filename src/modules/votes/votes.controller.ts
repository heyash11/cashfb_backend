import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { requireAuthedUser } from '../../shared/middleware/auth.middleware.js';
import { requireContext } from '../../shared/middleware/requestContext.js';
import { CastVoteBodySchema, TodayQuerySchema } from './votes.schemas.js';
import type { VoteService } from './votes.service.js';

export class VoteController {
  constructor(private readonly svc: VoteService) {}

  cast = async (req: Request, res: Response): Promise<void> => {
    const body = CastVoteBodySchema.parse(req.body);
    const user = requireAuthedUser(req);
    const ctx = requireContext(req);
    const data = await this.svc.castVote({
      userId: new Types.ObjectId(user.sub),
      tier: body.tier,
      target: body.target,
      ipAddress: ctx.ipAddress,
      deviceFingerprint: ctx.deviceFingerprint,
    });
    res.json({ success: true, data });
  };

  today = async (req: Request, res: Response): Promise<void> => {
    const query = TodayQuerySchema.parse(req.query);
    const user = requireAuthedUser(req);
    const data = await this.svc.getTodayStatus(new Types.ObjectId(user.sub), query.tier);
    res.json({ success: true, data });
  };
}
