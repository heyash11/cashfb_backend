import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { requireAuthedUser } from '../../shared/middleware/auth.middleware.js';
import { UserRepository } from '../../shared/repositories/User.repository.js';
import type { CustomRoomsService } from './custom-rooms.service.js';
import { ListRoomsQuerySchema, RoomIdParamsSchema } from './custom-rooms.schemas.js';

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
    const items = await this.service.listForDay({
      userId,
      userTier: user?.tier ?? 'PUBLIC',
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
    const result = await this.service.register(roomId, userId, user?.tier ?? 'PUBLIC');
    res.json({ success: true, data: result });
  };

  getResult = async (req: Request, res: Response): Promise<void> => {
    const { id: roomId } = RoomIdParamsSchema.parse(req.params);
    requireAuthedUser(req);
    const result = await this.service.getResult(roomId);
    res.json({ success: true, data: result });
  };
}
