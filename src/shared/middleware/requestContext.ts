import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { InternalError } from '../errors/AppError.js';

export interface RequestContext {
  reqId: string;
  ipAddress: string;
  userAgent: string;
  deviceId: string | null;
  deviceFingerprint: string | null;
}

/**
 * Attach a frozen `RequestContext` to every request.
 *
 * Controllers pull from `req.context` rather than reading headers
 * directly. This keeps handler code short, keeps header names in one
 * place, and lets Phase 3+ audit/middleware pipelines trust a single
 * authoritative source for the request's identity signals.
 *
 * Headers read:
 *   - X-Request-Id         (optional, else UUIDv4)
 *   - User-Agent
 *   - X-Device-Id          (nullable — set at first-launch in the app)
 *   - X-Device-Fingerprint (nullable — hashed client-side)
 */
export function requestContext(req: Request, _res: Response, next: NextFunction): void {
  const ctx: RequestContext = {
    reqId: req.header('x-request-id') ?? randomUUID(),
    ipAddress: req.ip ?? req.socket.remoteAddress ?? 'unknown',
    userAgent: req.header('user-agent') ?? 'unknown',
    deviceId: req.header('x-device-id') ?? null,
    deviceFingerprint: req.header('x-device-fingerprint') ?? null,
  };
  req.context = ctx;
  req.id = ctx.reqId;
  next();
}

/**
 * Unwrap `req.context` with a programming-error throw if the
 * middleware wasn't mounted. Controllers use this instead of banging
 * the optional property.
 */
export function requireContext(req: Request): RequestContext {
  if (!req.context) {
    throw new InternalError(
      'CONTEXT_MISSING',
      'requestContext middleware must be mounted before this handler',
    );
  }
  return req.context;
}
