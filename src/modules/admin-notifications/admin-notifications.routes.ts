import { Router } from 'express';
import { adminSession } from '../../shared/middleware/admin-session.js';
import { auditLog } from '../../shared/middleware/audit-log.js';
import { csrfCheck } from '../../shared/middleware/csrf.js';
import { ipAllowlist } from '../../shared/middleware/ip-allowlist.js';
import { requireAnyRole } from '../../shared/middleware/require-role.js';
import { AdminNotificationsController } from './admin-notifications.controller.js';
import type { AdminNotificationsService } from './admin-notifications.service.js';

/**
 * Mounted at /api/v1/admin/notifications. One write endpoint:
 * broadcast. Delivery is currently durable-only (Notification rows
 * in Mongo). FCM fan-out lands in Phase 10.
 */
export function createAdminNotificationsRouter(service: AdminNotificationsService): Router {
  const router = Router();
  const controller = new AdminNotificationsController(service);

  router.post(
    '/broadcast',
    ipAllowlist(),
    adminSession(),
    csrfCheck(),
    requireAnyRole('CONTENT_ADMIN', 'SUPER_ADMIN'),
    auditLog(
      { action: 'NOTIFICATION_BROADCAST', resourceKind: 'Notification' },
      controller.broadcast,
    ),
  );

  return router;
}
