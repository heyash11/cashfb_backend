import { Router } from 'express';
import { adminSession } from '../../shared/middleware/admin-session.js';
import { auditLog } from '../../shared/middleware/audit-log.js';
import { csrfCheck } from '../../shared/middleware/csrf.js';
import { ipAllowlist } from '../../shared/middleware/ip-allowlist.js';
import { requireAnyRole } from '../../shared/middleware/require-role.js';
import { AdminCmsController } from './admin-cms.controller.js';
import type { AdminCmsService } from './admin-cms.service.js';

/**
 * Mounted at /api/v1/admin/cms. Single audit action (CMS_UPSERT)
 * since create and update collapse to one PUT. List + getByKey are
 * reads, unaudited.
 */
export function createAdminCmsRouter(service: AdminCmsService): Router {
  const router = Router();
  const controller = new AdminCmsController(service);

  const baseChain = [ipAllowlist(), adminSession(), csrfCheck()] as const;
  const contentOrSuper = requireAnyRole('CONTENT_ADMIN', 'SUPER_ADMIN');

  router.get('/', ...baseChain, contentOrSuper, controller.list);
  router.get('/:key', ...baseChain, contentOrSuper, controller.getByKey);
  router.put(
    '/:key',
    ...baseChain,
    contentOrSuper,
    auditLog({ action: 'CMS_UPSERT', resourceKind: 'CmsContent' }, controller.upsert),
  );

  return router;
}
