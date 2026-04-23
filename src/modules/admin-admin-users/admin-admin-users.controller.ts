import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { ValidationError } from '../../shared/errors/AppError.js';
import type { AuditCaptureContext } from '../../shared/middleware/audit-log.js';
import type { AdminAdminUsersService } from './admin-admin-users.service.js';
import {
  AdminAdminUsersCreateBodySchema,
  AdminAdminUsersDeactivateBodySchema,
  AdminAdminUsersForceLogoutBodySchema,
  AdminAdminUsersListQuerySchema,
  AdminAdminUsersRoleChangeBodySchema,
  AdminAdminUsersToggle2FaBodySchema,
} from './admin-admin-users.schemas.js';

/**
 * Sensitive-field redaction is handled centrally by the auditLog
 * middleware (it applies `redactSensitive` to both the persisted
 * audit row AND the HTTP response body). Controllers pass full
 * model documents through and trust the middleware to strip
 * passwordHash + twoFactor.secret + twoFactor.recoveryCodes
 * before emission.
 *
 * The list endpoint is an exception — it is NOT audited, so the
 * controller strips passwordHash locally on its wire-format map.
 */
export class AdminAdminUsersController {
  constructor(private readonly service: AdminAdminUsersService) {}

  list = async (req: Request, res: Response): Promise<void> => {
    const q = AdminAdminUsersListQuerySchema.parse(req.query);
    const filter: Parameters<AdminAdminUsersService['list']>[0] = {};
    if (q.role) filter.role = q.role;
    if (q.disabled !== undefined) filter.disabled = q.disabled;
    const result = await this.service.list(filter);
    // Non-audited read — strip passwordHash on the wire format.
    const items = result.items.map((a) => {
      const { passwordHash: _pw, ...rest } = a;
      return rest;
    });
    res.json({ success: true, data: { items } });
  };

  create = async (req: Request): Promise<AuditCaptureContext> => {
    const body = AdminAdminUsersCreateBodySchema.parse(req.body);
    const createArgs: Parameters<AdminAdminUsersService['create']>[0] = {
      email: body.email,
      password: body.password,
      role: body.role,
    };
    if (body.name !== undefined) createArgs.name = body.name;
    const after = await this.service.create(createArgs);
    return { before: null, after, resourceKind: 'AdminUser', resourceId: after._id };
  };

  changeRole = async (req: Request): Promise<AuditCaptureContext> => {
    const id = parseObjectId(req.params.id, 'id');
    const body = AdminAdminUsersRoleChangeBodySchema.parse(req.body);
    const before = await this.service.getForAudit(id);
    const after = await this.service.changeRole(id, body.role);
    return {
      before,
      after: { ...after, reason: body.reason },
      resourceKind: 'AdminUser',
      resourceId: id,
    };
  };

  toggle2fa = async (req: Request): Promise<AuditCaptureContext> => {
    const id = parseObjectId(req.params.id, 'id');
    const body = AdminAdminUsersToggle2FaBodySchema.parse(req.body);
    const before = await this.service.getForAudit(id);
    const after = await this.service.toggle2fa(id, body.enabled);
    return {
      before,
      after: { ...after, reason: body.reason },
      resourceKind: 'AdminUser',
      resourceId: id,
    };
  };

  forceLogout = async (req: Request): Promise<AuditCaptureContext> => {
    const id = parseObjectId(req.params.id, 'id');
    const body = AdminAdminUsersForceLogoutBodySchema.parse(req.body);
    const result = await this.service.forceLogout(id);
    return {
      before: null,
      after: { destroyed: result.destroyed, reason: body.reason },
      resourceKind: 'AdminUser',
      resourceId: id,
    };
  };

  deactivate = async (req: Request): Promise<AuditCaptureContext> => {
    const id = parseObjectId(req.params.id, 'id');
    const body = AdminAdminUsersDeactivateBodySchema.parse(req.body);
    const before = await this.service.getForAudit(id);
    const after = await this.service.deactivate(id);
    return {
      before,
      after: { ...after, reason: body.reason },
      resourceKind: 'AdminUser',
      resourceId: id,
    };
  };
}

function parseObjectId(raw: unknown, field: string): Types.ObjectId {
  if (typeof raw !== 'string' || !Types.ObjectId.isValid(raw)) {
    throw new ValidationError(`Invalid ${field}`);
  }
  return new Types.ObjectId(raw);
}
