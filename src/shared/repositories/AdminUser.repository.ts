import type { Model } from 'mongoose';
import { AdminUserModel, type AdminUserAttrs } from '../models/AdminUser.model.js';
import { BaseRepository } from './_base.repository.js';

export class AdminUserRepository extends BaseRepository<AdminUserAttrs> {
  constructor(model: Model<AdminUserAttrs> = AdminUserModel) {
    super(model);
  }

  findByEmail(email: string): Promise<AdminUserAttrs | null> {
    return this.findOne({ email: email.toLowerCase().trim() });
  }
}
