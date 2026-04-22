import type { Model, Types } from 'mongoose';
import {
  CustomRoomResultModel,
  type CustomRoomResultAttrs,
} from '../models/CustomRoomResult.model.js';
import { BaseRepository } from './_base.repository.js';

export class CustomRoomResultRepository extends BaseRepository<CustomRoomResultAttrs> {
  constructor(model: Model<CustomRoomResultAttrs> = CustomRoomResultModel) {
    super(model);
  }

  findByRoom(roomId: Types.ObjectId | string): Promise<CustomRoomResultAttrs | null> {
    return this.findOne({ roomId });
  }
}
