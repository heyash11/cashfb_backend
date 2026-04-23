import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { logger } from '../../config/logger.js';
import { AuditLogModel, type AuditLogAttrs } from '../models/AuditLog.model.js';

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
 * Sensitive fields redacted via `redactSensitive` before write —
 * same field list as the pino redaction policy in
 * `src/config/logger.ts`.
 */
export function auditLog(opts: AuditLogOptions, handler: AuditedHandler) {
  return async function auditedHandler(
    req: Request,
    res: Response,
    next: (err?: unknown) => void,
  ): Promise<void> {
    try {
      const ctx = await handler(req, res);
      await writeAuditLog(req, opts, ctx);
      if (!res.headersSent) {
        res.json({
          success: true,
          data: ctx.after ?? { ok: true },
        });
      }
    } catch (err) {
      next(err);
    }
  };
}

/** Same list as pino redaction in logger.ts — keep in sync. */
const SENSITIVE_PATHS = [
  'passwordHash',
  'twoFactor.secret',
  'twoFactor.recoveryCodes',
  'panCt',
  'panIv',
  'panTag',
  'panDekEnc',
  'codeCt',
  'codeIv',
  'codeTag',
  'codeDekEnc',
  'roomIdCt',
  'roomIdIv',
  'roomIdTag',
  'roomIdDekEnc',
  'roomPwdCt',
  'roomPwdIv',
  'roomPwdTag',
  'roomPwdDekEnc',
];

export function redactSensitive(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redactSensitive);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_PATHS.includes(k)) {
      out[k] = '[REDACTED]';
    } else if (typeof v === 'object' && v !== null) {
      out[k] = redactSensitive(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Narrow arbitrary handler return values to the shape the AuditLog
 * model stores. Scalars / null / arrays are skipped (field is a
 * Record on the model); only plain objects are redacted and kept.
 */
function toAuditSnapshot(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return redactSensitive(value) as Record<string, unknown>;
}

async function writeAuditLog(
  req: Request,
  opts: AuditLogOptions,
  ctx: AuditCaptureContext,
): Promise<void> {
  const admin = req.admin;
  if (!admin) {
    logger.warn({ action: opts.action }, '[audit-log] no req.admin on audited handler');
    return;
  }
  const before = toAuditSnapshot(ctx.before);
  const after = toAuditSnapshot(ctx.after);
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
