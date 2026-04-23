import type { Request, Response } from 'express';
import type { AuditCaptureContext } from '../../shared/middleware/audit-log.js';
import type { AdminAppConfigService } from './admin-app-config.service.js';
import { AdminAppConfigPatchBodySchema } from './admin-app-config.schemas.js';

export class AdminAppConfigController {
  constructor(private readonly service: AdminAppConfigService) {}

  get = async (_req: Request, res: Response): Promise<void> => {
    const doc = await this.service.get();
    res.json({ success: true, data: doc });
  };

  update = async (req: Request): Promise<AuditCaptureContext> => {
    const patch = AdminAppConfigPatchBodySchema.parse(req.body);
    const before = await this.service.getForAudit();
    const after = await this.service.update(patch);
    return { before, after, resourceKind: 'AppConfig' };
  };
}
