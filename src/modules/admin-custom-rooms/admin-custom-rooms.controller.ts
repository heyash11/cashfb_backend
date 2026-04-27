import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { ValidationError } from '../../shared/errors/AppError.js';
import type { AuditCaptureContext } from '../../shared/middleware/audit-log.js';
import type {
  AdminCreateRoomInput,
  AdminCustomRoomsService,
  AdminEnterResultsInput,
  AdminListRoomsFilter,
  AssignWinnersInput,
  AssignWinnersInputItem,
} from '../custom-rooms/custom-rooms.admin.service.js';
import {
  AdminAssignWinnersBodySchema,
  AdminEnterResultsBodySchema,
  AdminRoomCreateBodySchema,
  AdminRoomCredentialsBodySchema,
  AdminRoomsListQuerySchema,
} from './admin-custom-rooms.schemas.js';

/**
 * HTTP thin layer over AdminCustomRoomsService. State transitions
 * (start/end/results) and winner assignment each get their own
 * audit action for narrow traceability on the prize-flow timeline.
 */
export class AdminCustomRoomsController {
  constructor(private readonly service: AdminCustomRoomsService) {}

  create = async (req: Request): Promise<AuditCaptureContext> => {
    const body = AdminRoomCreateBodySchema.parse(req.body);
    const actorId = new Types.ObjectId(req.admin!.adminId);
    const input: AdminCreateRoomInput = {
      game: body.game,
      dayKey: body.dayKey,
      scheduledAt: body.scheduledAt,
    };
    if (body.visibleFromAt !== undefined) input.visibleFromAt = body.visibleFromAt;
    if (body.resultEnabledAt !== undefined) input.resultEnabledAt = body.resultEnabledAt;
    if (body.tier !== undefined) input.tier = body.tier;
    if (body.pageNumber !== undefined) input.pageNumber = body.pageNumber;
    if (body.notice !== undefined) input.notice = body.notice;
    const after = await this.service.create(input, actorId);
    return { before: null, after, resourceId: after._id };
  };

  setCredentials = async (req: Request): Promise<AuditCaptureContext> => {
    const roomId = parseObjectId(req.params.id, 'id');
    const body = AdminRoomCredentialsBodySchema.parse(req.body);
    const actorId = new Types.ObjectId(req.admin!.adminId);
    const before = await this.service.getForAudit(roomId);
    await this.service.setCredentials(
      { roomId, plaintextRoomId: body.roomId, plaintextRoomPwd: body.roomPwd },
      actorId,
    );
    const after = await this.service.getForAudit(roomId);
    return { before, after, resourceId: roomId };
  };

  start = async (req: Request): Promise<AuditCaptureContext> => {
    const roomId = parseObjectId(req.params.id, 'id');
    const actorId = new Types.ObjectId(req.admin!.adminId);
    const before = await this.service.getForAudit(roomId);
    await this.service.startMatch(roomId, actorId);
    const after = await this.service.getForAudit(roomId);
    return { before, after, resourceId: roomId };
  };

  end = async (req: Request): Promise<AuditCaptureContext> => {
    const roomId = parseObjectId(req.params.id, 'id');
    const actorId = new Types.ObjectId(req.admin!.adminId);
    const before = await this.service.getForAudit(roomId);
    await this.service.endMatch(roomId, actorId);
    const after = await this.service.getForAudit(roomId);
    return { before, after, resourceId: roomId };
  };

  results = async (req: Request): Promise<AuditCaptureContext> => {
    const roomId = parseObjectId(req.params.id, 'id');
    const body = AdminEnterResultsBodySchema.parse(req.body);
    const actorId = new Types.ObjectId(req.admin!.adminId);
    const before = await this.service.getForAudit(roomId);
    const input: AdminEnterResultsInput = { roomId };
    if (body.inRoomImageUrl !== undefined) input.inRoomImageUrl = body.inRoomImageUrl;
    for (const bucket of ['top1', 'top2', 'top3', 'extra'] as const) {
      const val = body[bucket];
      if (val) {
        input[bucket] = {
          ...(val.imageUrl !== undefined ? { imageUrl: val.imageUrl } : {}),
          ...(val.squadName !== undefined ? { squadName: val.squadName } : {}),
          winners: val.winners.map((w) => ({
            userId: new Types.ObjectId(w.userId),
            prize: w.prize,
          })),
        };
      }
    }
    await this.service.enterResults(input, actorId);
    const after = await this.service.getForAudit(roomId);
    return { before, after, resourceId: roomId };
  };

  assignWinners = async (req: Request): Promise<AuditCaptureContext> => {
    const body = AdminAssignWinnersBodySchema.parse(req.body);
    const actorId = new Types.ObjectId(req.admin!.adminId);
    const winners: AssignWinnersInputItem[] = body.winners.map((w) => {
      const item: AssignWinnersInputItem = {
        userId: new Types.ObjectId(w.userId),
        type: w.type,
        baseAmount: w.baseAmount,
        tier: w.tier,
      };
      if (w.redeemCodeId) item.redeemCodeId = new Types.ObjectId(w.redeemCodeId);
      if (w.customRoomId) item.customRoomId = new Types.ObjectId(w.customRoomId);
      return item;
    });
    const input: AssignWinnersInput = { dayKey: body.dayKey, winners };
    const result = await this.service.assignWinners(input, actorId);
    return {
      before: null,
      after: {
        assigned: result.assigned,
        skippedCount: result.skipped.length,
      },
    };
  };

  list = async (req: Request, res: Response): Promise<void> => {
    const q = AdminRoomsListQuerySchema.parse(req.query);
    const filter: AdminListRoomsFilter = {};
    if (q.game) filter.game = q.game;
    if (q.status) filter.status = q.status;
    if (q.dayKey) filter.dayKey = q.dayKey;
    const result = await this.service.listAll(filter, q.cursor, q.limit);
    res.json({ success: true, data: result });
  };
}

function parseObjectId(raw: unknown, field: string): Types.ObjectId {
  if (typeof raw !== 'string' || !Types.ObjectId.isValid(raw)) {
    throw new ValidationError(`Invalid ${field}`);
  }
  return new Types.ObjectId(raw);
}
