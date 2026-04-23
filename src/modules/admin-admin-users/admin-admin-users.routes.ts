import { Router } from 'express';
import { adminSession } from '../../shared/middleware/admin-session.js';
import { auditLog } from '../../shared/middleware/audit-log.js';
import { csrfCheck } from '../../shared/middleware/csrf.js';
import { ipAllowlist } from '../../shared/middleware/ip-allowlist.js';
import { requireAnyRole } from '../../shared/middleware/require-role.js';
import { AdminAdminUsersController } from './admin-admin-users.controller.js';
import type { AdminAdminUsersService } from './admin-admin-users.service.js';

/**
 * Mounted at /api/v1/admin/admins. Every endpoint is SUPER_ADMIN
 * only — changes here include role escalations and 2FA toggles
 * which are themselves administrative primitives.
 */
export function createAdminAdminUsersRouter(service: AdminAdminUsersService): Router {
  const router = Router();
  const controller = new AdminAdminUsersController(service);

  const chain = [
    ipAllowlist(),
    adminSession(),
    csrfCheck(),
    requireAnyRole('SUPER_ADMIN'),
  ] as const;

  router.get('/', ...chain, controller.list);
  router.post(
    '/',
    ...chain,
    auditLog({ action: 'ADMIN_USER_CREATE', resourceKind: 'AdminUser' }, controller.create),
  );
  router.patch(
    '/:id/role',
    ...chain,
    auditLog(
      { action: 'ADMIN_USER_ROLE_CHANGE', resourceKind: 'AdminUser' },
      controller.changeRole,
    ),
  );
  router.post(
    '/:id/toggle-2fa',
    ...chain,
    auditLog({ action: 'ADMIN_USER_TOGGLE_2FA', resourceKind: 'AdminUser' }, controller.toggle2fa),
  );
  router.post(
    '/:id/force-logout',
    ...chain,
    auditLog(
      { action: 'ADMIN_USER_FORCE_LOGOUT', resourceKind: 'AdminUser' },
      controller.forceLogout,
    ),
  );
  router.delete(
    '/:id',
    ...chain,
    auditLog({ action: 'ADMIN_USER_DEACTIVATE', resourceKind: 'AdminUser' }, controller.deactivate),
  );

  return router;
}
