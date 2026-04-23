import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { NotFoundError, ValidationError } from '../../shared/errors/AppError.js';
import type { AuditCaptureContext } from '../../shared/middleware/audit-log.js';
import type { BrandSponsorAttrs } from '../../shared/models/BrandSponsor.model.js';
import type { AdminSponsorsService } from './admin-sponsors.service.js';
import {
  AdminSponsorCreateBodySchema,
  AdminSponsorUpdateBodySchema,
  AdminSponsorsListQuerySchema,
} from './admin-sponsors.schemas.js';

export class AdminSponsorsController {
  constructor(private readonly service: AdminSponsorsService) {}

  list = async (req: Request, res: Response): Promise<void> => {
    const q = AdminSponsorsListQuerySchema.parse(req.query);
    const filter: Parameters<AdminSponsorsService['list']>[0] = {};
    if (q.slot !== undefined) filter.slot = q.slot;
    if (q.status) filter.status = q.status;
    const result = await this.service.list(filter);
    res.json({ success: true, data: result });
  };

  create = async (req: Request): Promise<AuditCaptureContext> => {
    const body = AdminSponsorCreateBodySchema.parse(req.body);
    const input: Omit<BrandSponsorAttrs, '_id' | 'createdAt' | 'updatedAt'> = {
      slot: body.slot,
      imageUrl: body.imageUrl,
      priority: body.priority ?? 0,
      status: body.status ?? 'ACTIVE',
    };
    if (body.linkUrl !== undefined) input.linkUrl = body.linkUrl;
    if (body.title !== undefined) input.title = body.title;
    if (body.startAt !== undefined) input.startAt = body.startAt;
    if (body.endAt !== undefined) input.endAt = body.endAt;
    const after = await this.service.create(input);
    return { before: null, after, resourceKind: 'BrandSponsor', resourceId: after._id };
  };

  update = async (req: Request): Promise<AuditCaptureContext> => {
    const id = parseObjectId(req.params.id, 'id');
    const body = AdminSponsorUpdateBodySchema.parse(req.body);
    const before = await this.service.getForAudit(id);
    if (!before) throw new NotFoundError('Sponsor not found');
    // Build patch from only defined keys — Zod .optional() yields
    // explicit-undefined properties which exactOptionalPropertyTypes
    // rejects against Partial<BrandSponsorAttrs>.
    const patch: Partial<BrandSponsorAttrs> = {};
    if (body.slot !== undefined) patch.slot = body.slot;
    if (body.imageUrl !== undefined) patch.imageUrl = body.imageUrl;
    if (body.linkUrl !== undefined) patch.linkUrl = body.linkUrl;
    if (body.title !== undefined) patch.title = body.title;
    if (body.priority !== undefined) patch.priority = body.priority;
    if (body.startAt !== undefined) patch.startAt = body.startAt;
    if (body.endAt !== undefined) patch.endAt = body.endAt;
    if (body.status !== undefined) patch.status = body.status;
    const after = await this.service.update(id, patch);
    return { before, after, resourceKind: 'BrandSponsor', resourceId: id };
  };

  delete = async (req: Request): Promise<AuditCaptureContext> => {
    const id = parseObjectId(req.params.id, 'id');
    const before = await this.service.getForAudit(id);
    if (!before) throw new NotFoundError('Sponsor not found');
    await this.service.delete(id);
    return { before, after: null, resourceKind: 'BrandSponsor', resourceId: id };
  };
}

function parseObjectId(raw: unknown, field: string): Types.ObjectId {
  if (typeof raw !== 'string' || !Types.ObjectId.isValid(raw)) {
    throw new ValidationError(`Invalid ${field}`);
  }
  return new Types.ObjectId(raw);
}
