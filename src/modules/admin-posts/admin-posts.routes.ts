import { Router } from 'express';
import { adminSession } from '../../shared/middleware/admin-session.js';
import { auditLog } from '../../shared/middleware/audit-log.js';
import { csrfCheck } from '../../shared/middleware/csrf.js';
import { ipAllowlist } from '../../shared/middleware/ip-allowlist.js';
import { requireAnyRole } from '../../shared/middleware/require-role.js';
import type { AdminPostService } from '../posts/posts.admin.service.js';
import { AdminPostsController } from './admin-posts.controller.js';

/**
 * Mounted at /api/v1/admin/posts. Every route runs the full admin
 * middleware chain: ipAllowlist → adminSession → csrfCheck →
 * requireAnyRole → auditLog(for writes) → handler.
 *
 * CSRF bypasses SAFE methods (GET/HEAD/OPTIONS) internally, so the
 * read endpoint still runs csrfCheck but short-circuits. This keeps
 * the chain uniform across routes.
 */
export function createAdminPostsRouter(service: AdminPostService): Router {
  const router = Router();
  const controller = new AdminPostsController(service);

  const chain = [
    ipAllowlist(),
    adminSession(),
    csrfCheck(),
    requireAnyRole('CONTENT_ADMIN', 'SUPER_ADMIN'),
  ] as const;

  router.post(
    '/',
    ...chain,
    auditLog({ action: 'POST_CREATE', resourceKind: 'Post' }, controller.create),
  );
  router.patch(
    '/:id',
    ...chain,
    auditLog({ action: 'POST_UPDATE', resourceKind: 'Post' }, controller.update),
  );
  router.delete(
    '/:id',
    ...chain,
    auditLog({ action: 'POST_DELETE', resourceKind: 'Post' }, controller.delete),
  );
  router.get('/', ...chain, controller.list);

  return router;
}
