import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { ValidationError } from '../../shared/errors/AppError.js';
import type { AuditCaptureContext } from '../../shared/middleware/audit-log.js';
import type {
  AdminPostCreateInput,
  AdminPostService,
  AdminPostUpdateInput,
} from '../posts/posts.admin.service.js';
import {
  AdminPostCreateBodySchema,
  AdminPostListQuerySchema,
  AdminPostUpdateBodySchema,
} from './admin-posts.schemas.js';

/**
 * HTTP thin layer over AdminPostService. Handlers for audited writes
 * return an AuditCaptureContext; the auditLog wrapper in routes.ts
 * records the before/after snapshot and renders the success envelope.
 * Read handlers render their own response.
 */
export class AdminPostsController {
  constructor(private readonly service: AdminPostService) {}

  create = async (req: Request): Promise<AuditCaptureContext> => {
    const body = AdminPostCreateBodySchema.parse(req.body);
    const actorId = new Types.ObjectId(req.admin!.adminId);
    const input: AdminPostCreateInput = {
      title: body.title,
      dayKey: body.dayKey,
      scheduledAt: body.scheduledAt,
    };
    if (body.description !== undefined) input.description = body.description;
    if (body.status !== undefined) input.status = body.status;
    if (body.coinReward !== undefined) input.coinReward = body.coinReward;
    if (body.tier !== undefined) input.tier = body.tier;
    if (body.adsConfig !== undefined) input.adsConfig = pickAdsConfig(body.adsConfig);
    const after = await this.service.create(input, actorId);
    return { before: null, after, resourceId: after._id };
  };

  update = async (req: Request): Promise<AuditCaptureContext> => {
    const postId = parseObjectId(req.params.id, 'id');
    const body = AdminPostUpdateBodySchema.parse(req.body);
    const actorId = new Types.ObjectId(req.admin!.adminId);
    const patch: AdminPostUpdateInput = {};
    if (body.title !== undefined) patch.title = body.title;
    if (body.description !== undefined) patch.description = body.description;
    if (body.dayKey !== undefined) patch.dayKey = body.dayKey;
    if (body.scheduledAt !== undefined) patch.scheduledAt = body.scheduledAt;
    if (body.status !== undefined) patch.status = body.status;
    if (body.coinReward !== undefined) patch.coinReward = body.coinReward;
    if (body.tier !== undefined) patch.tier = body.tier;
    if (body.adsConfig !== undefined) patch.adsConfig = pickAdsConfig(body.adsConfig);
    if (body.publishedAt !== undefined) patch.publishedAt = body.publishedAt;
    if (body.closedAt !== undefined) patch.closedAt = body.closedAt;
    const before = await this.service.getForAudit(postId);
    const after = await this.service.update(postId, patch, actorId);
    return { before, after, resourceId: postId };
  };

  delete = async (req: Request): Promise<AuditCaptureContext> => {
    const postId = parseObjectId(req.params.id, 'id');
    const actorId = new Types.ObjectId(req.admin!.adminId);
    const before = await this.service.getForAudit(postId);
    await this.service.delete(postId, actorId);
    return { before, after: null, resourceId: postId };
  };

  list = async (req: Request, res: Response): Promise<void> => {
    const q = AdminPostListQuerySchema.parse(req.query);
    const items = await this.service.listByDate(q.dayKey, q.status);
    res.json({ success: true, data: { items } });
  };
}

function parseObjectId(raw: unknown, field: string): Types.ObjectId {
  if (typeof raw !== 'string' || !Types.ObjectId.isValid(raw)) {
    throw new ValidationError(`Invalid ${field}`);
  }
  return new Types.ObjectId(raw);
}

function pickAdsConfig(raw: {
  topBannerKey?: string | undefined;
  bottomBannerKey?: string | undefined;
}): { topBannerKey?: string; bottomBannerKey?: string } {
  const out: { topBannerKey?: string; bottomBannerKey?: string } = {};
  if (raw.topBannerKey !== undefined) out.topBannerKey = raw.topBannerKey;
  if (raw.bottomBannerKey !== undefined) out.bottomBannerKey = raw.bottomBannerKey;
  return out;
}
