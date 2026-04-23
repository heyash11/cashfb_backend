import type { NextFunction, Request, Response } from 'express';
import { InternalError, UnauthorizedError } from '../errors/AppError.js';
import { type AccessClaims, verifyAccessToken } from '../jwt/signer.js';
import { forceLogoutStore } from '../services/force-logout.js';

/**
 * Verify the incoming access JWT and attach claims to `req.user`.
 *
 * Access tokens live 15 minutes (SECURITY.md §1) and carry `sub`,
 * `tier`, `jti`, `iat`. The JWT signature + expiry handle ordinary
 * session invalidation.
 *
 * Phase 8 Chunk 3a adds a Redis force-logout denylist on top: one
 * GET per authenticated request against `auth:force-logout:<sub>`.
 * When set, any token whose `iat` is <= the cutoff is rejected —
 * the UX of "sign me out everywhere" without waiting the full 15
 * minutes for the access token to expire on its own.
 *
 * The denylist is intentionally per-user (not per-jti): one write
 * invalidates every outstanding access + refresh token for that
 * user in a single Redis op.
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

  let claims: AccessClaims;
  try {
    claims = await verifyAccessToken(token);
  } catch {
    next(new UnauthorizedError('Invalid or expired token'));
    return;
  }

  try {
    await forceLogoutStore.assertNotForceLoggedOut(claims.sub, claims.iat);
  } catch (err) {
    next(err);
    return;
  }

  req.user = claims;
  next();
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
