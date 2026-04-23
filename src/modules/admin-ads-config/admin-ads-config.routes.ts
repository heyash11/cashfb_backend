import { Router } from 'express';
import { adminSession } from '../../shared/middleware/admin-session.js';
import { auditLog } from '../../shared/middleware/audit-log.js';
import { csrfCheck } from '../../shared/middleware/csrf.js';
import { ipAllowlist } from '../../shared/middleware/ip-allowlist.js';
import { requireAnyRole } from '../../shared/middleware/require-role.js';
import { AdminAdsConfigController } from './admin-ads-config.controller.js';
import type { AdminAdsConfigService } from './admin-ads-config.service.js';

/**
 * Mounted at /api/v1/admin/ads-config. SUPER_ADMIN only — a
 * misconfigured ad placement is a revenue-path incident.
 */
export function createAdminAdsConfigRouter(service: AdminAdsConfigService): Router {
  const router = Router();
  const controller = new AdminAdsConfigController(service);

  const chain = [
    ipAllowlist(),
    adminSession(),
    csrfCheck(),
    requireAnyRole('SUPER_ADMIN'),
  ] as const;

  router.get('/', ...chain, controller.list);
  router.put(
    '/:placementKey',
    ...chain,
    auditLog({ action: 'ADS_CONFIG_UPSERT', resourceKind: 'AdsConfig' }, controller.upsert),
  );
  router.delete(
    '/:placementKey',
    ...chain,
    auditLog({ action: 'ADS_CONFIG_DELETE', resourceKind: 'AdsConfig' }, controller.delete),
  );

  return router;
}
