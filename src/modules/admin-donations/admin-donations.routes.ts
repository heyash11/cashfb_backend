import { Router } from 'express';
import { adminSession } from '../../shared/middleware/admin-session.js';
import { auditLog } from '../../shared/middleware/audit-log.js';
import { csrfCheck } from '../../shared/middleware/csrf.js';
import { ipAllowlist } from '../../shared/middleware/ip-allowlist.js';
import { requireAnyRole } from '../../shared/middleware/require-role.js';
import type { AdminDonationService } from '../donations/donations.admin.service.js';
import { AdminDonationsController } from './admin-donations.controller.js';

/**
 * Mounted at /api/v1/admin/donations. Roles follow Phase 8 plan:
 *   GET  /         — SUPPORT_ADMIN, PAYMENT_ADMIN, SUPER_ADMIN (read)
 *   POST /:id/feature — PAYMENT_ADMIN or SUPER_ADMIN (write)
 */
export function createAdminDonationsRouter(service: AdminDonationService): Router {
  const router = Router();
  const controller = new AdminDonationsController(service);

  const baseChain = [ipAllowlist(), adminSession(), csrfCheck()] as const;

  router.get(
    '/',
    ...baseChain,
    requireAnyRole('SUPPORT_ADMIN', 'PAYMENT_ADMIN', 'SUPER_ADMIN'),
    controller.list,
  );
  router.post(
    '/:id/feature',
    ...baseChain,
    requireAnyRole('PAYMENT_ADMIN', 'SUPER_ADMIN'),
    auditLog({ action: 'DONATION_FEATURE', resourceKind: 'Donation' }, controller.feature),
  );

  return router;
}
