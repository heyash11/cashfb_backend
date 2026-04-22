import type { FilterQuery, Model, Types } from 'mongoose';
import { AuditLogModel, type AuditLogAttrs } from '../models/AuditLog.model.js';
import { BaseRepository } from './_base.repository.js';

export class AuditLogRepository extends BaseRepository<AuditLogAttrs> {
  constructor(model: Model<AuditLogAttrs> = AuditLogModel) {
    super(model);
  }

  listForResource(kind: string, id: Types.ObjectId | string, limit = 50): Promise<AuditLogAttrs[]> {
    const filter: FilterQuery<AuditLogAttrs> = {
      'resource.kind': kind,
      'resource.id': id,
    };
    return this.model
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean<AuditLogAttrs[]>()
      .exec();
  }
}
