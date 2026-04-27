import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { ForbiddenError } from '../../shared/errors/AppError.js';
import { requireAuthedUser } from '../../shared/middleware/auth.middleware.js';
import { userCanAccessTier } from '../../shared/models/_tier.js';
import { UserRepository } from '../../shared/repositories/User.repository.js';
import type { CustomRoomsService } from './custom-rooms.service.js';
import { ListRoomsQuerySchema, RoomIdParamsSchema } from './custom-rooms.schemas.js';

/**
 * User-facing custom-rooms HTTP edge.
 *
 * Phase 11.4 — STRICT subscription-based auth on every endpoint.
 * Reads `User.subscriptions[]` and gates via `userCanAccessTier`.
 * One extra DB read per authed call; Phase 11.5 will optimize via
 * JWT claims carrying accessibleTiers.
 */
export class CustomRoomsController {
  constructor(
    private readonly service: CustomRoomsService,
    private readonly userRepo: UserRepository = new UserRepository(),
  ) {}

  list = async (req: Request, res: Response): Promise<void> => {
    const query = ListRoomsQuerySchema.parse(req.query);
    const authed = requireAuthedUser(req);
    const userId = new Types.ObjectId(authed.sub);
    const user = await this.userRepo.findById(userId);
    const subscriptions = user?.subscriptions ?? [];

    if (!userCanAccessTier(subscriptions, query.tier, new Date())) {
      throw new ForbiddenError(
        'TIER_NOT_ACCESSIBLE',
        `Subscription required to view ${query.tier} custom rooms`,
      );
    }

    const items = await this.service.listForDay({
      userId,
      subscriptions,
      tier: query.tier,
      game: query.game,
      page: query.page,
      ...(query.dayKey !== undefined ? { dayKey: query.dayKey } : {}),
    });
    res.json({ success: true, data: { items } });
  };

  register = async (req: Request, res: Response): Promise<void> => {
    const { id: roomId } = RoomIdParamsSchema.parse(req.params);
    const authed = requireAuthedUser(req);
    const userId = new Types.ObjectId(authed.sub);
    const user = await this.userRepo.findById(userId);
    const result = await this.service.register(roomId, userId, user?.subscriptions ?? []);
    res.json({ success: true, data: result });
  };

  getResult = async (req: Request, res: Response): Promise<void> => {
    const { id: roomId } = RoomIdParamsSchema.parse(req.params);
    requireAuthedUser(req);
    const result = await this.service.getResult(roomId);
    res.json({ success: true, data: result });
  };
}
