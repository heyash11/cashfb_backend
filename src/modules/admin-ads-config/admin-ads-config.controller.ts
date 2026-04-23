import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { NotFoundError, ValidationError } from '../../shared/errors/AppError.js';
import type { AuditCaptureContext } from '../../shared/middleware/audit-log.js';
import type { AdminAdsConfigService } from './admin-ads-config.service.js';
import {
  AdminAdsConfigPlacementParamSchema,
  AdminAdsConfigUpsertBodySchema,
} from './admin-ads-config.schemas.js';

export class AdminAdsConfigController {
  constructor(private readonly service: AdminAdsConfigService) {}

  list = async (_req: Request, res: Response): Promise<void> => {
    const result = await this.service.list();
    res.json({ success: true, data: result });
  };

  upsert = async (req: Request): Promise<AuditCaptureContext> => {
    const placementKey = parsePlacement(req.params.placementKey);
    const body = AdminAdsConfigUpsertBodySchema.parse(req.body);
    const actorId = new Types.ObjectId(req.admin!.adminId);
    const before = await this.service.getForAudit(placementKey);
    const after = await this.service.upsert(placementKey, body, actorId);
    return { before, after, resourceKind: 'AdsConfig' };
  };

  delete = async (req: Request): Promise<AuditCaptureContext> => {
    const placementKey = parsePlacement(req.params.placementKey);
    const before = await this.service.getForAudit(placementKey);
    if (!before) throw new NotFoundError('Ads-config placement not found');
    await this.service.delete(placementKey);
    return { before, after: null, resourceKind: 'AdsConfig' };
  };
}

function parsePlacement(raw: unknown): string {
  const result = AdminAdsConfigPlacementParamSchema.safeParse(raw);
  if (!result.success) {
    throw new ValidationError('Invalid placementKey', { received: raw });
  }
  return result.data;
}
