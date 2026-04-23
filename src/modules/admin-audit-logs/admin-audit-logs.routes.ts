import { Router } from 'express';
import { adminSession } from '../../shared/middleware/admin-session.js';
import { csrfCheck } from '../../shared/middleware/csrf.js';
import { ipAllowlist } from '../../shared/middleware/ip-allowlist.js';
import { requireAnyRole } from '../../shared/middleware/require-role.js';
import { AdminAuditLogsController } from './admin-audit-logs.controller.js';
import type { AdminAuditLogsService } from './admin-audit-logs.service.js';

/**
 * Mounted at /api/v1/admin/audit-logs. SUPER_ADMIN only — audit
 * trails may include sensitive before/after snapshots for any
 * resource. Read endpoint is NOT itself audited to avoid a
 * feedback loop (reading audit writing audit being shown in next
 * read).
 */
export function createAdminAuditLogsRouter(service: AdminAuditLogsService): Router {
  const router = Router();
  const controller = new AdminAuditLogsController(service);

  router.get(
    '/',
    ipAllowlist(),
    adminSession(),
    csrfCheck(),
    requireAnyRole('SUPER_ADMIN'),
    controller.list,
  );

  return router;
}
