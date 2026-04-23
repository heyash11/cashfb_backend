import { Router } from 'express';
import { adminSession } from '../../shared/middleware/admin-session.js';
import { auditLog } from '../../shared/middleware/audit-log.js';
import { csrfCheck } from '../../shared/middleware/csrf.js';
import { ipAllowlist } from '../../shared/middleware/ip-allowlist.js';
import { requireAnyRole } from '../../shared/middleware/require-role.js';
import type { AdminRedeemCodeService } from '../redeem-codes/redeem-codes.admin.service.js';
import { AdminRedeemCodesController } from './admin-redeem-codes.controller.js';
import { csvUploadHandler } from './admin-redeem-codes.multer.js';

/**
 * Mounted at /api/v1/admin/redeem-codes. Role gating per Phase 8 plan:
 *   POST  /upload            — CONTENT_ADMIN or SUPER_ADMIN
 *   POST  /publish           — CONTENT_ADMIN or SUPER_ADMIN
 *   POST  /:id/void          — SUPER_ADMIN only (irreversible invalidation)
 *   GET   /                  — CONTENT_ADMIN or SUPER_ADMIN
 *   GET   /export            — CONTENT_ADMIN or SUPER_ADMIN (streaming)
 */
export function createAdminRedeemCodesRouter(service: AdminRedeemCodeService): Router {
  const router = Router();
  const controller = new AdminRedeemCodesController(service);

  const baseChain = [ipAllowlist(), adminSession(), csrfCheck()] as const;
  const contentOrSuper = requireAnyRole('CONTENT_ADMIN', 'SUPER_ADMIN');
  const superOnly = requireAnyRole('SUPER_ADMIN');

  // Upload route intentionally deviates from baseChain:
  //   1. adminSession BEFORE multer — rejects unauthenticated uploads
  //      before allocating a 10 MB in-memory buffer.
  //   2. csrfCheck AFTER multer — multer must populate req.body from
  //      the multipart form first; CSRF is read from a header +
  //      cookie (never the body), so parsing order is safe.
  router.post(
    '/upload',
    ipAllowlist(),
    adminSession(),
    csvUploadHandler,
    csrfCheck(),
    contentOrSuper,
    auditLog({ action: 'REDEEM_CODE_UPLOAD', resourceKind: 'RedeemCodeBatch' }, controller.upload),
  );
  router.post(
    '/publish',
    ...baseChain,
    contentOrSuper,
    auditLog(
      { action: 'REDEEM_CODE_PUBLISH', resourceKind: 'RedeemCodeBatch' },
      controller.publish,
    ),
  );
  router.post(
    '/:id/void',
    ...baseChain,
    superOnly,
    auditLog({ action: 'REDEEM_CODE_VOID', resourceKind: 'RedeemCode' }, controller.void),
  );
  router.get('/', ...baseChain, contentOrSuper, controller.list);
  router.get('/export', ...baseChain, contentOrSuper, controller.export);

  return router;
}
