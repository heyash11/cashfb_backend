import { Router } from 'express';
import { adminSession } from '../../shared/middleware/admin-session.js';
import { auditLog } from '../../shared/middleware/audit-log.js';
import { csrfCheck } from '../../shared/middleware/csrf.js';
import { ipAllowlist } from '../../shared/middleware/ip-allowlist.js';
import { requireAnyRole } from '../../shared/middleware/require-role.js';
import { AdminSponsorsController } from './admin-sponsors.controller.js';
import type { AdminSponsorsService } from './admin-sponsors.service.js';

/**
 * Mounted at /api/v1/admin/sponsors. CONTENT_ADMIN can manage brand
 * slots; SUPER_ADMIN inherits.
 */
export function createAdminSponsorsRouter(service: AdminSponsorsService): Router {
  const router = Router();
  const controller = new AdminSponsorsController(service);

  const chain = [
    ipAllowlist(),
    adminSession(),
    csrfCheck(),
    requireAnyRole('CONTENT_ADMIN', 'SUPER_ADMIN'),
  ] as const;

  router.get('/', ...chain, controller.list);
  router.post(
    '/',
    ...chain,
    auditLog({ action: 'SPONSOR_CREATE', resourceKind: 'BrandSponsor' }, controller.create),
  );
  router.patch(
    '/:id',
    ...chain,
    auditLog({ action: 'SPONSOR_UPDATE', resourceKind: 'BrandSponsor' }, controller.update),
  );
  router.delete(
    '/:id',
    ...chain,
    auditLog({ action: 'SPONSOR_DELETE', resourceKind: 'BrandSponsor' }, controller.delete),
  );

  return router;
}
