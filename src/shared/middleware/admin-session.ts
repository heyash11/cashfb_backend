import type { NextFunction, Request, Response } from 'express';
import { UnauthorizedError } from '../errors/AppError.js';
import { AdminSessionStore } from '../sessions/admin-session.store.js';

export const ADMIN_SESSION_COOKIE = 'cfb_admin_session';

export interface AdminSessionMiddlewareDeps {
  store?: AdminSessionStore;
}

/**
 * Reads the session cookie, validates against Redis, hydrates
 * `req.admin`, and refreshes idle TTL via `touch()`. On expired,
 * absolute-expired, or missing session → 401 ADMIN_SESSION_INVALID.
 *
 * Depends on `cookie-parser` or equivalent being mounted upstream so
 * `req.cookies` is populated. Since Phase 8 is the first user of
 * cookies, we parse manually here to avoid adding a dependency just
 * for this middleware.
 */
export function adminSession(deps: AdminSessionMiddlewareDeps = {}) {
  const store = deps.store ?? new AdminSessionStore();

  return async function adminSessionMiddleware(
    req: Request,
    _res: Response,
    next: NextFunction,
  ): Promise<void> {
    const sessionId = extractCookie(req.headers.cookie, ADMIN_SESSION_COOKIE);
    if (!sessionId) {
      next(new UnauthorizedError('Missing admin session cookie'));
      return;
    }

    try {
      const session = await store.touch(sessionId);
      if (!session) {
        next(new UnauthorizedError('Admin session expired or invalid'));
        return;
      }
      req.admin = session;
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Parse a single cookie value out of a raw Cookie header. Minimal
 * implementation — we only need session + csrf names for Phase 8.
 * Spec: RFC 6265 §5.4 cookie-list format.
 */
export function extractCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const segment of header.split(';')) {
    const eq = segment.indexOf('=');
    if (eq === -1) continue;
    const key = segment.slice(0, eq).trim();
    if (key !== name) continue;
    const value = segment.slice(eq + 1).trim();
    // Strip optional surrounding quotes per RFC 6265 §5.2.
    if (value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1);
    return value;
  }
  return undefined;
}
