import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { logger } from '../../config/logger.js';
import { AuditLogModel, type AuditLogAttrs } from '../models/AuditLog.model.js';
import { redactSensitive } from '../utils/redact.js';

export interface AuditCaptureContext {
  /**
   * Loaded before the handler runs. Typically `null` for creates,
   * or a snapshot via the service's `getForAudit(id)` helper for
   * updates/deletes.
   */
  before: unknown;
  /**
   * Populated after the handler returns. Typically the created /
   * updated row, or `null` for deletes.
   */
  after: unknown;
  /** The resource this action targets. */
  resourceKind?: string;
  resourceId?: Types.ObjectId | string;
}

export interface AuditLogOptions {
  /** Canonical action name, e.g. `POST_CREATE`, `USER_BLOCK`. */
  action: string;
  /** Default resource kind; handlers can override per-call via
   *  the returned `AuditCaptureContext`. */
  resourceKind?: string;
}

export type AuditedHandler = (req: Request, res: Response) => Promise<AuditCaptureContext>;

/**
 * Audit-logging wrapper for admin write handlers.
 *
 * Usage:
 *   router.patch(
 *     '/:id/block',
 *     requireAnyRole('SUPPORT_ADMIN', 'SUPER_ADMIN'),
 *     auditLog({ action: 'USER_BLOCK', resourceKind: 'User' }, async (req) => {
 *       const before = await service.getForAudit(req.params.id);
 *       const after  = await service.block(req.params.id, req.body, req.admin.id);
 *       return { before, after, resourceId: after._id };
 *     }),
 *   );
 *
 * Writes to `audit_logs` on success. Does NOT log on handler error
 * (the error handler logs separately); audit is about what
 * succeeded.
 *
 * SECURITY: both the persisted `audit_logs` row AND the HTTP
 * response body surface `ctx.after`. Sensitive fields on that
 * payload (passwordHash, codeCt, panCt, room credentials, 2FA
 * secrets) are redacted by `redactSensitive` BEFORE either
 * emission. Controllers do NOT need their own sanitisers for any
 * field in `src/shared/utils/redact.ts`'s SENSITIVE_FIELD_LIST.
 */
export function auditLog(opts: AuditLogOptions, handler: AuditedHandler) {
  return async function auditedHandler(
    req: Request,
    res: Response,
    next: (err?: unknown) => void,
  ): Promise<void> {
    try {
      const ctx = await handler(req, res);
      const safeBefore = redactSensitive(ctx.before);
      const safeAfter = redactSensitive(ctx.after);
      await writeAuditLog(req, opts, ctx, safeBefore, safeAfter);
      if (!res.headersSent) {
        res.json({
          success: true,
          data: safeAfter ?? { ok: true },
        });
      }
    } catch (err) {
      next(err);
    }
  };
}

async function writeAuditLog(
  req: Request,
  opts: AuditLogOptions,
  ctx: AuditCaptureContext,
  safeBefore: unknown,
  safeAfter: unknown,
): Promise<void> {
  const admin = req.admin;
  if (!admin) {
    logger.warn({ action: opts.action }, '[audit-log] no req.admin on audited handler');
    return;
  }
  const before = toAuditSnapshot(safeBefore);
  const after = toAuditSnapshot(safeAfter);
  const data: Partial<AuditLogAttrs> = {
    actorId: new Types.ObjectId(admin.adminId),
    actorEmail: admin.adminEmail,
    action: opts.action,
    ...(before ? { before } : {}),
    ...(after ? { after } : {}),
    ip: req.ip ?? admin.ip,
    userAgent: req.header('user-agent') ?? admin.userAgent,
  };
  const kind = ctx.resourceKind ?? opts.resourceKind;
  if (kind || ctx.resourceId) {
    data.resource = {
      ...(kind ? { kind } : {}),
      ...(ctx.resourceId
        ? {
            id:
              typeof ctx.resourceId === 'string'
                ? new Types.ObjectId(ctx.resourceId)
                : ctx.resourceId,
          }
        : {}),
    };
  }
  await AuditLogModel.create(data);
}

/**
 * Narrow redacted handler-return values to the shape the AuditLog
 * model stores. Scalars / null / arrays are skipped (field is a
 * Record on the model); only plain objects survive.
 */
function toAuditSnapshot(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/**
 * Re-export for consumers that imported `redactSensitive` from this
 * module before the helper moved to `src/shared/utils/redact.ts`.
 */
export { redactSensitive } from '../utils/redact.js';
