import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { ValidationError } from '../../shared/errors/AppError.js';
import type { AuditCaptureContext } from '../../shared/middleware/audit-log.js';
import { AdminDlqListQuerySchema, AdminDlqRequeueBodySchema } from './admin-dlq.schemas.js';
import type { AdminDlqService } from './admin-dlq.service.js';

export class AdminDlqController {
  constructor(private readonly service: AdminDlqService) {}

  list = async (req: Request, res: Response): Promise<void> => {
    const q = AdminDlqListQuerySchema.parse(req.query);
    const result = await this.service.list({
      includeRequeued: q.includeRequeued,
      limit: q.limit,
    });
    res.json({ success: true, data: result });
  };

  requeue = async (req: Request): Promise<AuditCaptureContext> => {
    const jobId = parseJobId(req.params.jobId);
    const body = AdminDlqRequeueBodySchema.parse(req.body);
    const actorId = new Types.ObjectId(req.admin!.adminId);
    const result = await this.service.requeue({
      jobId,
      reason: body.reason,
      actorId,
      actorEmail: req.admin!.adminEmail,
    });
    return {
      before: { originalJobId: result.originalJobId, originalQueue: result.originalQueue },
      after: {
        requeuedToJobId: result.requeuedToJobId,
        auditId: result.auditId,
        reason: body.reason,
      },
      resourceKind: 'DlqAudit',
      resourceId: result.auditId,
    };
  };
}

function parseJobId(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length < 1 || raw.length > 200) {
    throw new ValidationError('Invalid jobId');
  }
  return raw;
}
