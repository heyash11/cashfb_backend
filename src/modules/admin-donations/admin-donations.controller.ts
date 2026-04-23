import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { ValidationError } from '../../shared/errors/AppError.js';
import type { AuditCaptureContext } from '../../shared/middleware/audit-log.js';
import type {
  AdminDonationService,
  AdminListDonationsFilter,
} from '../donations/donations.admin.service.js';
import { AdminDonationsListQuerySchema } from './admin-donations.schemas.js';

export class AdminDonationsController {
  constructor(private readonly service: AdminDonationService) {}

  list = async (req: Request, res: Response): Promise<void> => {
    const q = AdminDonationsListQuerySchema.parse(req.query);
    const filter: AdminListDonationsFilter = {};
    if (q.userId) filter.userId = new Types.ObjectId(q.userId);
    if (q.status) filter.status = q.status;
    if (q.from) filter.from = q.from;
    if (q.to) filter.to = q.to;
    const result = await this.service.listAll(filter, q.cursor, q.limit);
    res.json({ success: true, data: result });
  };

  feature = async (req: Request): Promise<AuditCaptureContext> => {
    const donationId = parseObjectId(req.params.id, 'id');
    const actorId = new Types.ObjectId(req.admin!.adminId);
    const before = await this.service.getForAudit(donationId);
    await this.service.markFeatured(donationId, actorId);
    const after = await this.service.getForAudit(donationId);
    return { before, after, resourceId: donationId };
  };
}

function parseObjectId(raw: unknown, field: string): Types.ObjectId {
  if (typeof raw !== 'string' || !Types.ObjectId.isValid(raw)) {
    throw new ValidationError(`Invalid ${field}`);
  }
  return new Types.ObjectId(raw);
}
