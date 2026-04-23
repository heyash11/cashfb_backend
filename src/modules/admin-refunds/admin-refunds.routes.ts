import { Router } from 'express';
import { adminSession } from '../../shared/middleware/admin-session.js';
import { auditLog } from '../../shared/middleware/audit-log.js';
import { csrfCheck } from '../../shared/middleware/csrf.js';
import { ipAllowlist } from '../../shared/middleware/ip-allowlist.js';
import { requireAnyRole } from '../../shared/middleware/require-role.js';
import type { RefundService } from '../refunds/refunds.service.js';
import { AdminRefundsController } from './admin-refunds.controller.js';

/**
 * Mounted at /api/v1/admin/refunds. Narrowest role allowlist in
 * Chunk 2 — PAYMENT_ADMIN or SUPER_ADMIN only. SUPPORT_ADMIN can
 * read donations/subscriptions but cannot trigger the money flow.
 */
export function createAdminRefundsRouter(service: RefundService): Router {
  const router = Router();
  const controller = new AdminRefundsController(service);

  const chain = [
    ipAllowlist(),
    adminSession(),
    csrfCheck(),
    requireAnyRole('PAYMENT_ADMIN', 'SUPER_ADMIN'),
  ] as const;

  router.post(
    '/',
    ...chain,
    auditLog(
      { action: 'REFUND_INITIATE', resourceKind: 'SubscriptionPayment' },
      controller.initiate,
    ),
  );

  return router;
}
