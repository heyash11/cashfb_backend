import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import type {
  AdminAuditLogsListFilter,
  AdminAuditLogsService,
} from './admin-audit-logs.service.js';
import { AdminAuditLogsListQuerySchema } from './admin-audit-logs.schemas.js';

export class AdminAuditLogsController {
  constructor(private readonly service: AdminAuditLogsService) {}

  list = async (req: Request, res: Response): Promise<void> => {
    const q = AdminAuditLogsListQuerySchema.parse(req.query);
    const filter: AdminAuditLogsListFilter = {};
    if (q.actorId) filter.actorId = new Types.ObjectId(q.actorId);
    if (q.resourceKind) filter.resourceKind = q.resourceKind;
    if (q.resourceId) filter.resourceId = new Types.ObjectId(q.resourceId);
    if (q.action) filter.action = q.action;
    if (q.from) filter.from = q.from;
    if (q.to) filter.to = q.to;
    const result = await this.service.list(filter, q.cursor, q.limit);
    res.json({ success: true, data: result });
  };
}
