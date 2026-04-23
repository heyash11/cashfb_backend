import { Router } from 'express';
import { adminSession } from '../../shared/middleware/admin-session.js';
import { csrfCheck } from '../../shared/middleware/csrf.js';
import { ipAllowlist } from '../../shared/middleware/ip-allowlist.js';
import { requireAnyRole } from '../../shared/middleware/require-role.js';
import type { AdminSubscriptionService } from '../subscriptions/subscriptions.admin.service.js';
import { AdminSubscriptionsController } from './admin-subscriptions.controller.js';

/**
 * Mounted at /api/v1/admin/subscriptions. Reads only — refund + tier
 * writes belong to separate services. Role split per Phase 8 plan:
 *   GET /         — SUPPORT_ADMIN, PAYMENT_ADMIN, SUPER_ADMIN (low-sensitivity read)
 *   GET /revenue  — PAYMENT_ADMIN or SUPER_ADMIN (financial report)
 */
export function createAdminSubscriptionsRouter(service: AdminSubscriptionService): Router {
  const router = Router();
  const controller = new AdminSubscriptionsController(service);

  const baseChain = [ipAllowlist(), adminSession(), csrfCheck()] as const;

  router.get(
    '/',
    ...baseChain,
    requireAnyRole('SUPPORT_ADMIN', 'PAYMENT_ADMIN', 'SUPER_ADMIN'),
    controller.list,
  );
  router.get(
    '/revenue',
    ...baseChain,
    requireAnyRole('PAYMENT_ADMIN', 'SUPER_ADMIN'),
    controller.revenue,
  );

  return router;
}
