import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { ValidationError } from '../../shared/errors/AppError.js';
import type { AuditCaptureContext } from '../../shared/middleware/audit-log.js';
import type { AdminUsersService } from './admin-users.service.js';
import {
  AdminUserBlockBodySchema,
  AdminUserCoinAdjustBodySchema,
  AdminUserErasureHoldBodySchema,
  AdminUserErasureHoldClearBodySchema,
  AdminUserForceLogoutBodySchema,
  AdminUserUnblockBodySchema,
  AdminUsersListQuerySchema,
} from './admin-users.schemas.js';

export class AdminUsersController {
  constructor(private readonly service: AdminUsersService) {}

  list = async (req: Request, res: Response): Promise<void> => {
    const q = AdminUsersListQuerySchema.parse(req.query);
    const filter = {
      ...(q.search ? { search: q.search } : {}),
      ...(q.tier ? { tier: q.tier } : {}),
      ...(q.blocked !== undefined ? { blocked: q.blocked } : {}),
    };
    const result = await this.service.list(filter, q.limit);
    res.json({ success: true, data: result });
  };

  block = async (req: Request): Promise<AuditCaptureContext> => {
    const userId = parseObjectId(req.params.id, 'id');
    const body = AdminUserBlockBodySchema.parse(req.body);
    const actorId = new Types.ObjectId(req.admin!.adminId);
    const before = await this.service.getForAudit(userId);
    const after = await this.service.block(userId, body.reason, actorId);
    return { before, after, resourceId: userId };
  };

  unblock = async (req: Request): Promise<AuditCaptureContext> => {
    const userId = parseObjectId(req.params.id, 'id');
    AdminUserUnblockBodySchema.parse(req.body);
    const actorId = new Types.ObjectId(req.admin!.adminId);
    const before = await this.service.getForAudit(userId);
    const after = await this.service.unblock(userId, actorId);
    return { before, after, resourceId: userId };
  };

  /**
   * Coin-adjust response shape explicitly surfaces `delta` at the
   * top of the audit `after` payload so reviewers don't have to
   * subtract before/after by hand. The reason is also lifted into
   * the audit row (redundant with the coin_transactions.reason
   * field, but lets admins grep `audit_logs` alone).
   */
  adjustCoins = async (req: Request): Promise<AuditCaptureContext> => {
    const userId = parseObjectId(req.params.id, 'id');
    const body = AdminUserCoinAdjustBodySchema.parse(req.body);
    const actorId = new Types.ObjectId(req.admin!.adminId);
    // The transactional adjustCoins returns balanceBefore/After so we
    // don't need a separate getForAudit pre-read — one fewer round
    // trip to Mongo + no race between snapshot and mutation.
    const adjust = await this.service.adjustCoins({
      userId,
      delta: body.delta,
      reason: body.reason,
      actorId,
    });
    return {
      before: {
        coinBalance: adjust.balanceBefore,
      },
      after: {
        coinBalance: adjust.balanceAfter,
        delta: adjust.delta,
        reason: body.reason,
        coinTxId: adjust.coinTxId,
      },
      resourceKind: 'User',
      resourceId: userId,
    };
  };

  forceLogout = async (req: Request): Promise<AuditCaptureContext> => {
    const userId = parseObjectId(req.params.id, 'id');
    const body = AdminUserForceLogoutBodySchema.parse(req.body);
    const result = await this.service.forceLogout(userId);
    return {
      before: null,
      after: {
        cutoff: result.cutoff,
        reason: body.reason,
      },
      resourceKind: 'User',
      resourceId: userId,
    };
  };

  applyErasureHold = async (req: Request): Promise<AuditCaptureContext> => {
    const userId = parseObjectId(req.params.id, 'id');
    const body = AdminUserErasureHoldBodySchema.parse(req.body);
    const actorId = new Types.ObjectId(req.admin!.adminId);
    const result = await this.service.applyErasureHold(userId, body.reason, actorId);
    return {
      before: null,
      after: {
        held: true,
        heldAt: result.heldAt,
        reason: result.reason,
      },
      resourceKind: 'User',
      resourceId: userId,
    };
  };

  clearErasureHold = async (req: Request): Promise<AuditCaptureContext> => {
    const userId = parseObjectId(req.params.id, 'id');
    AdminUserErasureHoldClearBodySchema.parse(req.body);
    const actorId = new Types.ObjectId(req.admin!.adminId);
    const result = await this.service.clearErasureHold(userId, actorId);
    return {
      before: null,
      after: {
        held: false,
        clearedAt: result.clearedAt,
        deletedAtAdvancedTo: result.deletedAtAdvancedTo,
      },
      resourceKind: 'User',
      resourceId: userId,
    };
  };
}

function parseObjectId(raw: unknown, field: string): Types.ObjectId {
  if (typeof raw !== 'string' || !Types.ObjectId.isValid(raw)) {
    throw new ValidationError(`Invalid ${field}`);
  }
  return new Types.ObjectId(raw);
}
