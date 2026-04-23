import { Router } from 'express';
import { adminSession } from '../../shared/middleware/admin-session.js';
import { auditLog } from '../../shared/middleware/audit-log.js';
import { csrfCheck } from '../../shared/middleware/csrf.js';
import { ipAllowlist } from '../../shared/middleware/ip-allowlist.js';
import { requireAnyRole } from '../../shared/middleware/require-role.js';
import type { AdminCustomRoomsService } from '../custom-rooms/custom-rooms.admin.service.js';
import { AdminCustomRoomsController } from './admin-custom-rooms.controller.js';

/**
 * Mounted at /api/v1/admin/custom-rooms. Role split per Phase 8 plan:
 *   GET  /                           — CONTENT_ADMIN, SUPPORT_ADMIN, SUPER_ADMIN
 *   POST /:id/winners                — PAYMENT_ADMIN or SUPER_ADMIN (financial)
 *   Every other write                — CONTENT_ADMIN or SUPER_ADMIN
 *
 * State transitions (start/end/results) each get their own audit
 * action so the prize-flow timeline is traceable without joining
 * multiple rows.
 */
export function createAdminCustomRoomsRouter(service: AdminCustomRoomsService): Router {
  const router = Router();
  const controller = new AdminCustomRoomsController(service);

  const baseChain = [ipAllowlist(), adminSession(), csrfCheck()] as const;
  const contentWrite = requireAnyRole('CONTENT_ADMIN', 'SUPER_ADMIN');
  const paymentWrite = requireAnyRole('PAYMENT_ADMIN', 'SUPER_ADMIN');
  const readRoles = requireAnyRole('CONTENT_ADMIN', 'SUPPORT_ADMIN', 'SUPER_ADMIN');

  router.post(
    '/',
    ...baseChain,
    contentWrite,
    auditLog({ action: 'CUSTOM_ROOM_CREATE', resourceKind: 'CustomRoom' }, controller.create),
  );
  router.post(
    '/:id/credentials',
    ...baseChain,
    contentWrite,
    auditLog(
      { action: 'CUSTOM_ROOM_CREDENTIALS', resourceKind: 'CustomRoom' },
      controller.setCredentials,
    ),
  );
  router.post(
    '/:id/start',
    ...baseChain,
    contentWrite,
    auditLog({ action: 'CUSTOM_ROOM_START', resourceKind: 'CustomRoom' }, controller.start),
  );
  router.post(
    '/:id/end',
    ...baseChain,
    contentWrite,
    auditLog({ action: 'CUSTOM_ROOM_END', resourceKind: 'CustomRoom' }, controller.end),
  );
  router.post(
    '/:id/results',
    ...baseChain,
    contentWrite,
    auditLog({ action: 'CUSTOM_ROOM_RESULTS', resourceKind: 'CustomRoom' }, controller.results),
  );
  router.post(
    '/:id/winners',
    ...baseChain,
    paymentWrite,
    auditLog(
      { action: 'CUSTOM_ROOM_WINNERS', resourceKind: 'CustomRoom' },
      controller.assignWinners,
    ),
  );
  router.get('/', ...baseChain, readRoles, controller.list);

  return router;
}
