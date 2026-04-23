import { Router } from 'express';
import { adminSession } from '../../shared/middleware/admin-session.js';
import { auditLog } from '../../shared/middleware/audit-log.js';
import { csrfCheck } from '../../shared/middleware/csrf.js';
import { ipAllowlist } from '../../shared/middleware/ip-allowlist.js';
import { requireAnyRole } from '../../shared/middleware/require-role.js';
import { AdminAppConfigController } from './admin-app-config.controller.js';
import type { AdminAppConfigService } from './admin-app-config.service.js';

/**
 * Mounted at /api/v1/admin/app-config. SUPER_ADMIN only — this
 * singleton carries feature flags, IP allowlist, base rates, and
 * other high-sensitivity config.
 */
export function createAdminAppConfigRouter(service: AdminAppConfigService): Router {
  const router = Router();
  const controller = new AdminAppConfigController(service);

  const chain = [
    ipAllowlist(),
    adminSession(),
    csrfCheck(),
    requireAnyRole('SUPER_ADMIN'),
  ] as const;

  router.get('/', ...chain, controller.get);
  router.patch(
    '/',
    ...chain,
    auditLog({ action: 'APP_CONFIG_UPDATE', resourceKind: 'AppConfig' }, controller.update),
  );

  return router;
}
