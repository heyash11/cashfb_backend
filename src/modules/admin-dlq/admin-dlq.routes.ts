import { Router } from 'express';
import { adminSession } from '../../shared/middleware/admin-session.js';
import { auditLog } from '../../shared/middleware/audit-log.js';
import { csrfCheck } from '../../shared/middleware/csrf.js';
import { ipAllowlist } from '../../shared/middleware/ip-allowlist.js';
import { requireAnyRole } from '../../shared/middleware/require-role.js';
import { AdminDlqController } from './admin-dlq.controller.js';
import type { AdminDlqService } from './admin-dlq.service.js';

/**
 * Mounted at /api/v1/admin/dlq.
 *   GET  /?includeRequeued=…       — SUPER_ADMIN only (raw job payloads may leak secrets)
 *   POST /:jobId/requeue           — SUPER_ADMIN only (replays work)
 */
export function createAdminDlqRouter(service: AdminDlqService): Router {
  const router = Router();
  const controller = new AdminDlqController(service);

  const baseChain = [ipAllowlist(), adminSession(), csrfCheck()] as const;
  const superOnly = requireAnyRole('SUPER_ADMIN');

  router.get('/', ...baseChain, superOnly, controller.list);
  router.post(
    '/:jobId/requeue',
    ...baseChain,
    superOnly,
    auditLog({ action: 'DLQ_REQUEUE', resourceKind: 'DlqAudit' }, controller.requeue),
  );

  return router;
}
