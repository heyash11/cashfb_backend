import type { NextFunction, Request, Response } from 'express';
import { InternalError, UnauthorizedError } from '../errors/AppError.js';
import { type AccessClaims, verifyAccessToken } from '../jwt/signer.js';

/**
 * Verify the incoming access JWT and attach claims to `req.user`.
 *
 * Intentionally DB-free. SECURITY.md §1 access tokens live 15 minutes
 * and carry only `sub`, `tier`, `jti`. We do NOT cross-check
 * `login_sessions` here — the 15-minute expiry is the revocation
 * guardrail for consumer tokens. Admin tokens (Phase 8) will layer a
 * Redis denylist on top for hard revocation; that's scoped to admin
 * middleware, not this one.
 *
 * Implication: if a refresh-revoked session's access token is still
 * within its 15-minute window, it keeps working until it expires.
 * Acceptable risk for consumer traffic; documented in SECURITY.md.
 */
export async function requireUser(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const header = req.header('authorization');
  if (!header || !header.startsWith('Bearer ')) {
    next(new UnauthorizedError('Missing bearer token'));
    return;
  }

  const token = header.slice('Bearer '.length).trim();
  if (!token) {
    next(new UnauthorizedError('Empty bearer token'));
    return;
  }

  try {
    const claims = await verifyAccessToken(token);
    req.user = claims;
    next();
  } catch {
    next(new UnauthorizedError('Invalid or expired token'));
  }
}

/**
 * Unwrap `req.user` with a programming-error throw if `requireUser`
 * wasn't mounted. Controllers on authed routes use this instead of
 * banging the optional property.
 */
export function requireAuthedUser(req: Request): AccessClaims {
  if (!req.user) {
    throw new InternalError(
      'USER_MISSING',
      'requireUser middleware must be mounted before this handler',
    );
  }
  return req.user;
}
