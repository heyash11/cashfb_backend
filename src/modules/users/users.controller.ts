import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { requireAuthedUser } from '../../shared/middleware/auth.middleware.js';
import type { UserCoinsService } from './users.coins.service.js';
import type { UserProfileService } from './users.profile.service.js';
import { ListCoinsQuerySchema } from './users.schemas.js';

/**
 * HTTP edge for `/me/*`. Phase 3 shipped `/me/coins`; Phase 9.6
 * adds `/me` for identity hydration. KYC / session / device-token
 * endpoints from API.md §2 land in later phases.
 */
export class UsersController {
  constructor(
    private readonly coinsService: UserCoinsService,
    private readonly profileService: UserProfileService,
  ) {}

  /**
   * GET /api/v1/me — hydrate the authenticated user's identity for
   * UI rendering. Returns a privacy-filtered DTO; see
   * UserProfileService for the full field-by-field contract and
   * the auth-middleware-vs-handler defense-in-depth rationale.
   */
  getMe = async (req: Request, res: Response): Promise<void> => {
    const claims = requireAuthedUser(req);
    const profile = await this.profileService.getMe(new Types.ObjectId(claims.sub));
    res.json({ success: true, data: profile });
  };

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
