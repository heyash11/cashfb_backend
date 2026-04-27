import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { ForbiddenError } from '../../shared/errors/AppError.js';
import { requireAuthedUser } from '../../shared/middleware/auth.middleware.js';
import { userCanAccessTier } from '../../shared/models/_tier.js';
import type { CustomRoomsService } from './custom-rooms.service.js';
import { ListRoomsQuerySchema, RoomIdParamsSchema } from './custom-rooms.schemas.js';

/**
 * User-facing custom-rooms HTTP edge.
 *
 * Phase 11.5 — auth middleware attaches `subscriptions[]` to
 * `req.user`. Controllers consume directly; no duplicate fetch.
 */
export class CustomRoomsController {
  constructor(private readonly service: CustomRoomsService) {}

  list = async (req: Request, res: Response): Promise<void> => {
    const query = ListRoomsQuerySchema.parse(req.query);
    const claims = requireAuthedUser(req);
    const userId = new Types.ObjectId(claims.sub);

    if (!userCanAccessTier(claims.subscriptions, query.tier, new Date())) {
      throw new ForbiddenError(
        'TIER_NOT_ACCESSIBLE',
        `Subscription required to view ${query.tier} custom rooms`,
      );
    }

    const items = await this.service.listForDay({
      userId,
      subscriptions: claims.subscriptions,
      tier: query.tier,
      game: query.game,
      page: query.page,
      ...(query.dayKey !== undefined ? { dayKey: query.dayKey } : {}),
    });
    res.json({ success: true, data: { items } });
  };

  register = async (req: Request, res: Response): Promise<void> => {
    const { id: roomId } = RoomIdParamsSchema.parse(req.params);
    const claims = requireAuthedUser(req);
    const userId = new Types.ObjectId(claims.sub);
    const result = await this.service.register(roomId, userId, claims.subscriptions);
    res.json({ success: true, data: result });
  };

  getResult = async (req: Request, res: Response): Promise<void> => {
    const { id: roomId } = RoomIdParamsSchema.parse(req.params);
    requireAuthedUser(req);
    const result = await this.service.getResult(roomId);
    res.json({ success: true, data: result });
  };
}
