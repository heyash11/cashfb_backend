import type { Request, Response } from 'express';
import type { PrizePoolService } from './prize-pools.service.js';
import { TodayPoolQuerySchema } from './prize-pools.schemas.js';

export class PrizePoolsController {
  constructor(private readonly svc: PrizePoolService) {}

  today = async (req: Request, res: Response): Promise<void> => {
    const query = TodayPoolQuerySchema.parse(req.query);
    const data = await this.svc.getTodayForTier(query.tier);
    res.json({ success: true, data });
  };
}
