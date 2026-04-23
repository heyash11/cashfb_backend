import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { NotFoundError, ValidationError } from '../../shared/errors/AppError.js';
import type { AuditCaptureContext } from '../../shared/middleware/audit-log.js';
import type { AdminCmsService } from './admin-cms.service.js';
import { AdminCmsUpsertBodySchema, CmsKeySchema } from './admin-cms.schemas.js';

export class AdminCmsController {
  constructor(private readonly service: AdminCmsService) {}

  list = async (_req: Request, res: Response): Promise<void> => {
    const result = await this.service.list();
    res.json({ success: true, data: result });
  };

  getByKey = async (req: Request, res: Response): Promise<void> => {
    const key = parseKey(req.params.key);
    const row = await this.service.getByKey(key);
    if (!row) throw new NotFoundError('CMS entry not found');
    res.json({ success: true, data: row });
  };

  upsert = async (req: Request): Promise<AuditCaptureContext> => {
    const key = parseKey(req.params.key);
    const body = AdminCmsUpsertBodySchema.parse(req.body);
    const actorId = new Types.ObjectId(req.admin!.adminId);
    const before = await this.service.getForAudit(key);
    const after = await this.service.upsert(key, body.html, actorId);
    return { before, after, resourceKind: 'CmsContent' };
  };
}

function parseKey(raw: unknown): ReturnType<typeof CmsKeySchema.parse> {
  const result = CmsKeySchema.safeParse(raw);
  if (!result.success) {
    throw new ValidationError('Invalid CMS key', { received: raw });
  }
  return result.data;
}
