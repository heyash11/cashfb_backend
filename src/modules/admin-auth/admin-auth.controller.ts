import type { Request, Response } from 'express';
import { env } from '../../config/env.js';
import { UnauthorizedError } from '../../shared/errors/AppError.js';
import { ADMIN_SESSION_COOKIE, extractCookie } from '../../shared/middleware/admin-session.js';
import { CSRF_COOKIE } from '../../shared/middleware/csrf.js';
import type { AdminAuthService } from './admin-auth.service.js';
import { AdminLoginBodySchema } from './admin-auth.schemas.js';

/**
 * Cookie helpers. Both cookies are `Path=/api/v1/admin`-scoped so
 * they never reach the user-facing surface. `Secure` is
 * env-gated — skipped in dev so localhost HTTP works, enforced in
 * prod via NODE_ENV.
 */
const COOKIE_PATH = '/api/v1/admin';

function cookieHeaders(sessionId: string, csrfToken: string, maxAgeMs: number): string[] {
  const secure = env.NODE_ENV === 'production' ? '; Secure' : '';
  const maxAge = Math.floor(maxAgeMs / 1000);
  return [
    `${ADMIN_SESSION_COOKIE}=${sessionId}; Path=${COOKIE_PATH}; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${secure}`,
    // CSRF cookie is intentionally NOT HttpOnly — client JS reads it
    // to set the X-CSRF-Token header on writes (double-submit).
    `${CSRF_COOKIE}=${csrfToken}; Path=${COOKIE_PATH}; Max-Age=${maxAge}; SameSite=Strict${secure}`,
  ];
}

function clearCookieHeaders(): string[] {
  const secure = env.NODE_ENV === 'production' ? '; Secure' : '';
  return [
    `${ADMIN_SESSION_COOKIE}=; Path=${COOKIE_PATH}; Max-Age=0; HttpOnly; SameSite=Strict${secure}`,
    `${CSRF_COOKIE}=; Path=${COOKIE_PATH}; Max-Age=0; SameSite=Strict${secure}`,
  ];
}

export class AdminAuthController {
  constructor(private readonly service: AdminAuthService) {}

  login = async (req: Request, res: Response): Promise<void> => {
    const body = AdminLoginBodySchema.parse(req.body);
    const result = await this.service.login({
      email: body.email,
      password: body.password,
      ...(body.totpCode !== undefined ? { totpCode: body.totpCode } : {}),
      ip: req.ip ?? 'unknown',
      userAgent: req.header('user-agent') ?? 'unknown',
    });

    const cookieMaxAgeMs = result.absoluteExpiresAt - Date.now();
    res.setHeader('Set-Cookie', cookieHeaders(result.sessionId, result.csrfToken, cookieMaxAgeMs));
    res.json({
      success: true,
      data: {
        admin: result.admin,
        csrfToken: result.csrfToken, // also returned in body so clients don't race the cookie set
        absoluteExpiresAt: result.absoluteExpiresAt,
      },
    });
  };

  logout = async (req: Request, res: Response): Promise<void> => {
    const sessionId = extractCookie(req.headers.cookie, ADMIN_SESSION_COOKIE);
    if (sessionId) await this.service.logout(sessionId);
    res.setHeader('Set-Cookie', clearCookieHeaders());
    res.json({ success: true, data: { ok: true } });
  };

  me = async (req: Request, res: Response): Promise<void> => {
    // Requires adminSession middleware — req.admin hydrated.
    if (!req.admin) {
      throw new UnauthorizedError('Admin session required');
    }
    res.json({
      success: true,
      data: {
        admin: {
          id: req.admin.adminId,
          email: req.admin.adminEmail,
          role: req.admin.role,
          permissions: req.admin.permissions,
        },
      },
    });
  };

  rotateCsrf = async (req: Request, res: Response): Promise<void> => {
    if (!req.admin) {
      throw new UnauthorizedError('Admin session required');
    }
    const rotated = await this.service.rotateCsrf(req.admin.sessionId);
    if (!rotated) {
      throw new UnauthorizedError('Session no longer valid');
    }
    const secure = env.NODE_ENV === 'production' ? '; Secure' : '';
    res.setHeader(
      'Set-Cookie',
      `${CSRF_COOKIE}=${rotated.csrfToken}; Path=${COOKIE_PATH}; SameSite=Strict${secure}`,
    );
    res.json({ success: true, data: { csrfToken: rotated.csrfToken } });
  };
}
