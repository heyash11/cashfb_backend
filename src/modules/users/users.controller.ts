import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { requireAuthedUser } from '../../shared/middleware/auth.middleware.js';
import type { UserCoinsService } from './users.coins.service.js';
import { ListCoinsQuerySchema } from './users.schemas.js';

/**
 * HTTP edge for `/me/*`. Phase 3 exposes `/me/coins` only; profile /
 * KYC / session endpoints from API.md §2 land in later phases.
 */
export class UsersController {
  constructor(private readonly coinsService: UserCoinsService) {}

  listCoins = async (req: Request, res: Response): Promise<void> => {
    const query = ListCoinsQuerySchema.parse(req.query);
    const user = requireAuthedUser(req);
    const result = await this.coinsService.listTransactions({
      userId: new Types.ObjectId(user.sub),
      ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
      limit: query.limit,
    });
    res.json({ success: true, data: result });
  };
}
