import type { NextFunction, Request, Response } from 'express';
import { Types } from 'mongoose';
import { InternalError, UnauthorizedError } from '../errors/AppError.js';
import { type AccessClaims, verifyAccessToken } from '../jwt/signer.js';
import { UserModel, type UserSubscriptionEntry } from '../models/User.model.js';
import { forceLogoutStore } from '../services/force-logout.js';

/**
 * Phase 11.5 — `AuthedReqUser` extends the JWT claims with
 * `subscriptions[]` fetched at middleware time. Downstream
 * controllers (posts/custom-rooms/votes/me) read directly from
 * `req.user.subscriptions` instead of duplicate-fetching the User
 * row. Net DB-reads-per-authed-request: 1 (centralized here).
 */
export interface AuthedReqUser extends AccessClaims {
  subscriptions: UserSubscriptionEntry[];
}

/**
 * Verify the incoming access JWT, check the force-logout
 * mechanisms, and attach `req.user`.
 *
 * Verify chain (Phase 11.5):
 *   1. JWT signature + expiry (jose).
 *   2. Redis force-logout denylist (Phase 8 / Phase 9 DPDP path) —
 *      per-user `iat` cutoff, ad-hoc invalidation primitive.
 *   3. User row fetch (subscriptions, tokenVersion, blocked).
 *   4. tokenVersion match (Phase 11.5) — bulk-invalidation
 *      primary, bumped at deploy time. Mismatch → 401
 *      TOKEN_VERSION_MISMATCH.
 *
 * The User fetch is the new cost (Phase 11.5 makes it ubiquitous);
 * the read is wrapped to a `lean()` projection of just the fields
 * we need, and the result is attached to `req.user.subscriptions`
 * so controllers don't repeat the fetch.
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

  // Phase 11.5 — User fetch + tokenVersion check + subscriptions
  // attachment. The lean projection keeps memory tight; the User
  // row is only as large as we need it.
  const userId = (() => {
    try {
      return new Types.ObjectId(claims.sub);
    } catch {
      return null;
    }
  })();
  if (!userId) {
    next(new UnauthorizedError('Invalid sub claim'));
    return;
  }

  const user = await UserModel.findById(userId, {
    _id: 1,
    tokenVersion: 1,
    subscriptions: 1,
    blocked: 1,
  }).lean<{
    _id: Types.ObjectId;
    tokenVersion?: number;
    subscriptions?: UserSubscriptionEntry[];
    blocked?: { isBlocked: boolean };
  } | null>();

  if (!user) {
    next(new UnauthorizedError('User not found'));
    return;
  }

  // tokenVersion check. Pre-11.5 tokens (no claim) parse as 0; the
  // User default is 1, so the comparison correctly fires re-login
  // on stale tokens. Same path triggered when an operator runs
  // bump-token-versions to invalidate every existing JWT.
  const userTokenVersion = user.tokenVersion ?? 1;
  if (claims.tokenVersion !== userTokenVersion) {
    next(new UnauthorizedError('TOKEN_VERSION_MISMATCH'));
    return;
  }

  const authed: AuthedReqUser = {
    ...claims,
    subscriptions: user.subscriptions ?? [],
  };
  req.user = authed;
  next();
}

/**
 * Unwrap `req.user` with a programming-error throw if `requireUser`
 * wasn't mounted. Controllers on authed routes use this instead of
 * banging the optional property.
 */
export function requireAuthedUser(req: Request): AuthedReqUser {
  if (!req.user) {
    throw new InternalError(
      'USER_MISSING',
      'requireUser middleware must be mounted before this handler',
    );
  }
  return req.user as AuthedReqUser;
}
