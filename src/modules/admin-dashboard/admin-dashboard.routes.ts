import { Router } from 'express';
import { adminSession } from '../../shared/middleware/admin-session.js';
import { csrfCheck } from '../../shared/middleware/csrf.js';
import { ipAllowlist } from '../../shared/middleware/ip-allowlist.js';
import { requireAnyRole } from '../../shared/middleware/require-role.js';
import { AdminDashboardController } from './admin-dashboard.controller.js';
import type { AdminDashboardService } from './admin-dashboard.service.js';

/**
 * Mounted at /api/v1/admin/dashboard. Single read endpoint backed by
 * a 60s Redis cache. Any admin role can see the dashboard — data is
 * aggregate counts, not PII.
 */
export function createAdminDashboardRouter(service: AdminDashboardService): Router {
  const router = Router();
  const controller = new AdminDashboardController(service);

  router.get(
    '/metrics',
    ipAllowlist(),
    adminSession(),
    csrfCheck(),
    requireAnyRole('SUPPORT_ADMIN', 'PAYMENT_ADMIN', 'CONTENT_ADMIN', 'SUPER_ADMIN'),
    controller.metrics,
  );

  return router;
}
