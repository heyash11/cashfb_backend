import type { NextFunction, Request, Response } from 'express';
import { ForbiddenError } from '../errors/AppError.js';
import type { AdminRole } from '../sessions/admin-session.store.js';

/**
 * RBAC middleware for admin routes. Runs AFTER `adminSession` so
 * `req.admin` is populated.
 *
 * `requireRole('SUPER_ADMIN')` — exact match.
 * `requireAnyRole('CONTENT_ADMIN', 'SUPER_ADMIN')` — one of the listed roles.
 * `requirePermission('users.block')` — granular override via
 *      `AdminUser.permissions[]` (allows non-role-based grants).
 *
 * SECURITY.md §2 role matrix is the source of truth for who can
 * touch what; this middleware just enforces the decision at the
 * route level.
 */
export function requireRole(role: AdminRole) {
  return function requireRoleMiddleware(req: Request, _res: Response, next: NextFunction): void {
    if (!req.admin) {
      next(new ForbiddenError('FORBIDDEN', 'Admin session required'));
      return;
    }
    if (req.admin.role !== role) {
      next(
        new ForbiddenError('FORBIDDEN', `Role ${role} required`, {
          actualRole: req.admin.role,
          requiredRole: role,
        }),
      );
      return;
    }
    next();
  };
}

export function requireAnyRole(...roles: AdminRole[]) {
  return function requireAnyRoleMiddleware(req: Request, _res: Response, next: NextFunction): void {
    if (!req.admin) {
      next(new ForbiddenError('FORBIDDEN', 'Admin session required'));
      return;
    }
    if (!roles.includes(req.admin.role)) {
      next(
        new ForbiddenError('FORBIDDEN', `One of [${roles.join(', ')}] required`, {
          actualRole: req.admin.role,
          requiredRoles: roles,
        }),
      );
      return;
    }
    next();
  };
}

export function requirePermission(permission: string) {
  return function requirePermissionMiddleware(
    req: Request,
    _res: Response,
    next: NextFunction,
  ): void {
    if (!req.admin) {
      next(new ForbiddenError('FORBIDDEN', 'Admin session required'));
      return;
    }
    // SUPER_ADMIN implicitly has every permission.
    if (req.admin.role === 'SUPER_ADMIN') {
      next();
      return;
    }
    if (!req.admin.permissions.includes(permission)) {
      next(
        new ForbiddenError('FORBIDDEN', `Permission ${permission} required`, {
          actualRole: req.admin.role,
        }),
      );
      return;
    }
    next();
  };
}
