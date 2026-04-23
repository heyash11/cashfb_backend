import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { ForbiddenError } from '../errors/AppError.js';
import { extractCookie } from './admin-session.js';

export const CSRF_COOKIE = 'cfb_admin_csrf';
export const CSRF_HEADER = 'x-csrf-token';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Double-submit CSRF validation. Middleware expects `req.admin` to
 * already be populated by `adminSession`. On writes
 * (POST/PATCH/DELETE/PUT), compares:
 *
 *   1. the `cfb_admin_csrf` cookie (set non-HttpOnly at login so
 *      client JS can read it) vs
 *   2. the `X-CSRF-Token` header (client-supplied on every write) vs
 *   3. the session's stored `csrfToken`
 *
 * All three must match (timing-safe compare). GET/HEAD/OPTIONS
 * bypass the check — those can't mutate state.
 *
 * The triple-match (cookie + header + session) defends against both
 * the classic CSRF attack (attacker-origin can set neither cookie
 * nor header correctly) AND a cookie-injection attack (attacker
 * sets the cookie; header comparison against session closes it).
 */
export function csrfCheck() {
  return function csrfMiddleware(req: Request, _res: Response, next: NextFunction): void {
    if (SAFE_METHODS.has(req.method)) {
      next();
      return;
    }
    if (!req.admin) {
      next(new ForbiddenError('CSRF_INVALID', 'Admin session required before CSRF check'));
      return;
    }

    const headerToken = req.header(CSRF_HEADER);
    const cookieToken = extractCookie(req.headers.cookie, CSRF_COOKIE);
    const sessionToken = req.admin.csrfToken;

    if (!headerToken || !cookieToken) {
      next(new ForbiddenError('CSRF_INVALID', 'CSRF header or cookie missing'));
      return;
    }

    if (!safeEqual(headerToken, cookieToken) || !safeEqual(headerToken, sessionToken)) {
      next(new ForbiddenError('CSRF_INVALID', 'CSRF token mismatch'));
      return;
    }

    next();
  };
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}
