import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { ValidationError } from '../../shared/errors/AppError.js';
import type { AuditCaptureContext } from '../../shared/middleware/audit-log.js';
import type { AdminUserAttrs } from '../../shared/models/AdminUser.model.js';
import type { AdminAdminUsersService } from './admin-admin-users.service.js';
import {
  AdminAdminUsersCreateBodySchema,
  AdminAdminUsersDeactivateBodySchema,
  AdminAdminUsersForceLogoutBodySchema,
  AdminAdminUsersListQuerySchema,
  AdminAdminUsersRoleChangeBodySchema,
  AdminAdminUsersToggle2FaBodySchema,
} from './admin-admin-users.schemas.js';

export class AdminAdminUsersController {
  constructor(private readonly service: AdminAdminUsersService) {}

  list = async (req: Request, res: Response): Promise<void> => {
    const q = AdminAdminUsersListQuerySchema.parse(req.query);
    const filter: Parameters<AdminAdminUsersService['list']>[0] = {};
    if (q.role) filter.role = q.role;
    if (q.disabled !== undefined) filter.disabled = q.disabled;
    const result = await this.service.list(filter);
    // Strip passwordHash from the wire response — never exposed.
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
    // auditLog middleware surfaces ctx.after as the HTTP response
    // body; strip passwordHash + twoFactor.secret at the controller
    // so they never reach the client. The audit_logs row is still
    // redacted independently via redactSensitive.
    return {
      before: null,
      after: sanitizeAdminUser(after),
      resourceKind: 'AdminUser',
      resourceId: after._id,
    };
  };

  changeRole = async (req: Request): Promise<AuditCaptureContext> => {
    const id = parseObjectId(req.params.id, 'id');
    const body = AdminAdminUsersRoleChangeBodySchema.parse(req.body);
    const before = sanitizeBefore(await this.service.getForAudit(id));
    const after = await this.service.changeRole(id, body.role);
    return {
      before,
      after: { ...sanitizeAdminUser(after), reason: body.reason },
      resourceKind: 'AdminUser',
      resourceId: id,
    };
  };

  toggle2fa = async (req: Request): Promise<AuditCaptureContext> => {
    const id = parseObjectId(req.params.id, 'id');
    const body = AdminAdminUsersToggle2FaBodySchema.parse(req.body);
    const before = sanitizeBefore(await this.service.getForAudit(id));
    const after = await this.service.toggle2fa(id, body.enabled);
    return {
      before,
      after: { ...sanitizeAdminUser(after), reason: body.reason },
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
    const before = sanitizeBefore(await this.service.getForAudit(id));
    const after = await this.service.deactivate(id);
    return {
      before,
      after: { ...sanitizeAdminUser(after), reason: body.reason },
      resourceKind: 'AdminUser',
      resourceId: id,
    };
  };
}

/**
 * Strip passwordHash + twoFactor.secret from an AdminUser doc.
 * Audit middleware surfaces ctx.before/after as the HTTP response
 * AND as the audit_logs row. Without this sanitiser, the response
 * would leak the bcrypt hash to the SUPER_ADMIN caller; the audit
 * row redaction handles the persisted copy separately.
 */
function sanitizeAdminUser(a: AdminUserAttrs): Omit<
  AdminUserAttrs,
  'passwordHash' | 'twoFactor'
> & {
  twoFactor: { enabled: boolean; recoveryCodes: string[] };
} {
  const { passwordHash: _pw, twoFactor, ...rest } = a;
  return {
    ...rest,
    twoFactor: { enabled: twoFactor.enabled, recoveryCodes: [] },
  };
}

function sanitizeBefore(a: AdminUserAttrs | null): ReturnType<typeof sanitizeAdminUser> | null {
  return a ? sanitizeAdminUser(a) : null;
}

function parseObjectId(raw: unknown, field: string): Types.ObjectId {
  if (typeof raw !== 'string' || !Types.ObjectId.isValid(raw)) {
    throw new ValidationError(`Invalid ${field}`);
  }
  return new Types.ObjectId(raw);
}
