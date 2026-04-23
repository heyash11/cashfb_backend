import type { NextFunction, Request, Response } from 'express';
import { ForbiddenError } from '../errors/AppError.js';
import { AppConfigRepository } from '../repositories/AppConfig.repository.js';

export interface IpAllowlistDeps {
  appConfigRepo?: AppConfigRepository;
}

/**
 * Tenant-wide admin IP allowlist gate. Runs BEFORE session
 * validation so the session-lookup path is never reached for
 * disallowed IPs. Per-admin narrowing happens inside the session-
 * aware code path (enforced at login by AdminAuthService — see
 * §IP allowlist in admin-auth.service.ts).
 *
 * Semantics:
 *   - `AppConfig.adminIpAllowlist` empty → allow all (dev/staging).
 *   - `AppConfig.adminIpAllowlist` non-empty → req.ip must be in list.
 *   - Denial throws 403 ADMIN_IP_NOT_ALLOWED with
 *     `details.rejectedBy: 'tenant'` for audit-log diagnostics.
 *
 * No Redis / Mongo caching in Phase 8 — the admin surface is
 * low-volume. Phase 9+ can add a 60-second AppConfig cache if the
 * read cost becomes material.
 */
export function ipAllowlist(deps: IpAllowlistDeps = {}) {
  const appConfigRepo = deps.appConfigRepo ?? new AppConfigRepository();
  return async function ipAllowlistMiddleware(
    req: Request,
    _res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const cfg = await appConfigRepo.findOne({ key: 'default' });
      const tenantList = cfg?.adminIpAllowlist ?? [];
      if (tenantList.length === 0) {
        next();
        return;
      }
      const ip = req.ip ?? '';
      if (!tenantList.includes(ip)) {
        next(
          new ForbiddenError('ADMIN_IP_NOT_ALLOWED', 'IP not in tenant allowlist', {
            rejectedBy: 'tenant',
            ip,
          }),
        );
        return;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
