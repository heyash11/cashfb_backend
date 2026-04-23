import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { ValidationError } from '../../shared/errors/AppError.js';
import type { AuditCaptureContext } from '../../shared/middleware/audit-log.js';
import type { PrizePoolService } from '../prize-pools/prize-pools.service.js';
import type { AdminPrizePoolsService } from './admin-prize-pools.service.js';
import {
  AdminMarkPayoutBodySchema,
  AdminPrizePoolRunBodySchema,
  AdminPrizePoolWinnersQuerySchema,
  AdminPrizePoolsListQuerySchema,
} from './admin-prize-pools.schemas.js';

export class AdminPrizePoolsController {
  constructor(
    private readonly service: AdminPrizePoolsService,
    private readonly coreService: PrizePoolService,
  ) {}

  list = async (req: Request, res: Response): Promise<void> => {
    const q = AdminPrizePoolsListQuerySchema.parse(req.query);
    const filter = q.status ? { status: q.status } : {};
    const result = await this.service.list(filter, q.limit);
    res.json({ success: true, data: result });
  };

  /**
   * Manual trigger — wraps the existing Phase 6 compute primitive.
   * Typically used when the midnight cron was missed (maintenance
   * window) or when the accountant wants to re-publish after a
   * votes-collection correction. Returns `{created: false, …}` when
   * the row already exists — idempotent at the service layer.
   */
  run = async (req: Request): Promise<AuditCaptureContext> => {
    const body = AdminPrizePoolRunBodySchema.parse(req.body);
    const result = await this.coreService.computeAndPublishPool({
      dayKey: body.dayKey,
      yesterdayDayKey: body.yesterdayDayKey,
    });
    return {
      before: null,
      after: { ...result, reason: body.reason },
      resourceKind: 'PrizePool',
    };
  };

  listWinners = async (req: Request, res: Response): Promise<void> => {
    const q = AdminPrizePoolWinnersQuerySchema.parse(req.query);
    const filter = q.payoutStatus
      ? { dayKey: q.dayKey, payoutStatus: q.payoutStatus }
      : { dayKey: q.dayKey };
    const result = await this.service.listWinners(filter);
    res.json({ success: true, data: result });
  };

  markPayout = async (req: Request): Promise<AuditCaptureContext> => {
    const winnerId = parseObjectId(req.params.id, 'id');
    const body = AdminMarkPayoutBodySchema.parse(req.body);
    const actorId = new Types.ObjectId(req.admin!.adminId);
    const before = await this.service.getWinnerForAudit(winnerId);
    const after = await this.service.markPayout({
      winnerId,
      payoutStatus: body.payoutStatus,
      ...(body.challanNo !== undefined ? { challanNo: body.challanNo } : {}),
      ...(body.panLast4 !== undefined ? { panLast4: body.panLast4 } : {}),
      actorId,
    });
    return {
      before,
      after: { ...after, reason: body.reason },
      resourceKind: 'PrizePoolWinner',
      resourceId: winnerId,
    };
  };
}

function parseObjectId(raw: unknown, field: string): Types.ObjectId {
  if (typeof raw !== 'string' || !Types.ObjectId.isValid(raw)) {
    throw new ValidationError(`Invalid ${field}`);
  }
  return new Types.ObjectId(raw);
}
