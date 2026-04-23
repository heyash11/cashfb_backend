import { Router } from 'express';
import { adminSession } from '../../shared/middleware/admin-session.js';
import { auditLog } from '../../shared/middleware/audit-log.js';
import { csrfCheck } from '../../shared/middleware/csrf.js';
import { ipAllowlist } from '../../shared/middleware/ip-allowlist.js';
import { requireAnyRole } from '../../shared/middleware/require-role.js';
import { AdminUsersController } from './admin-users.controller.js';
import type { AdminUsersService } from './admin-users.service.js';

/**
 * Mounted at /api/v1/admin/users. Role split per Phase 8 plan:
 *   GET   /                         — SUPPORT, PAYMENT, SUPER (read)
 *   POST  /:id/block, /unblock      — SUPPORT or SUPER
 *   POST  /:id/coins                — PAYMENT or SUPER (financial; reason required)
 *   POST  /:id/force-logout         — SUPER only (invalidates every outstanding session)
 */
export function createAdminUsersRouter(service: AdminUsersService): Router {
  const router = Router();
  const controller = new AdminUsersController(service);

  const baseChain = [ipAllowlist(), adminSession(), csrfCheck()] as const;
  const readRoles = requireAnyRole('SUPPORT_ADMIN', 'PAYMENT_ADMIN', 'SUPER_ADMIN');
  const supportOrSuper = requireAnyRole('SUPPORT_ADMIN', 'SUPER_ADMIN');
  const paymentOrSuper = requireAnyRole('PAYMENT_ADMIN', 'SUPER_ADMIN');
  const superOnly = requireAnyRole('SUPER_ADMIN');

  router.get('/', ...baseChain, readRoles, controller.list);
  router.post(
    '/:id/block',
    ...baseChain,
    supportOrSuper,
    auditLog({ action: 'USER_BLOCK', resourceKind: 'User' }, controller.block),
  );
  router.post(
    '/:id/unblock',
    ...baseChain,
    supportOrSuper,
    auditLog({ action: 'USER_UNBLOCK', resourceKind: 'User' }, controller.unblock),
  );
  router.post(
    '/:id/coins',
    ...baseChain,
    paymentOrSuper,
    auditLog({ action: 'USER_COINS_ADJUST', resourceKind: 'User' }, controller.adjustCoins),
  );
  router.post(
    '/:id/force-logout',
    ...baseChain,
    superOnly,
    auditLog({ action: 'USER_FORCE_LOGOUT', resourceKind: 'User' }, controller.forceLogout),
  );

  return router;
}
