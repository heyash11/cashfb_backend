import type { Model } from 'mongoose';
import { CustomRoomModel, type CustomRoomAttrs } from '../models/CustomRoom.model.js';
import { BaseRepository } from './_base.repository.js';

export class CustomRoomRepository extends BaseRepository<CustomRoomAttrs> {
  constructor(model: Model<CustomRoomAttrs> = CustomRoomModel) {
    super(model);
  }

  listForDay(
    dayKey: string,
    game: 'BGMI' | 'FF',
    page = 1,
    pageSize = 8,
  ): Promise<CustomRoomAttrs[]> {
    return this.model
      .find({ dayKey, game })
      .sort({ scheduledAt: 1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean<CustomRoomAttrs[]>()
      .exec();
  }
}
