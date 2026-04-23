import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import type { RequestHandler, Router } from 'express';
import { env } from './env.js';
import { logger } from './logger.js';
import { getQueue } from './queues.js';
import { adminSession } from '../shared/middleware/admin-session.js';
import { ipAllowlist } from '../shared/middleware/ip-allowlist.js';
import { requireRole } from '../shared/middleware/require-role.js';
import { QUEUES } from '../workers/_registry.js';

/**
 * Bull-board dashboard mounted at `env.BULL_DASHBOARD_PATH`
 * (default `/admin/queues`). Provides queue + job inspection,
 * retry-from-dashboard, and DLQ visibility.
 *
 * Guard chain (Phase 8): ipAllowlist → adminSession → requireRole.
 * CSRF is intentionally omitted — bull-board's UI issues both
 * state-changing and read-only requests under the same path, and
 * the SUPER_ADMIN scope combined with the session cookie's
 * SameSite=Strict is the defence here. Audit logging of bull-
 * board actions is deferred to a future pass since bull-board
 * owns the request lifecycle.
 */

export interface BullBoardMount {
  basePath: string;
  router: Router;
  guards: RequestHandler[];
}

export function buildBullBoard(): BullBoardMount {
  const serverAdapter = new ExpressAdapter();
  const basePath = env.BULL_DASHBOARD_PATH;
  serverAdapter.setBasePath(basePath);

  const queueNames = [QUEUES.CRON, QUEUES.INVOICE, QUEUES.WEBHOOK_RETRY, env.BULL_DLQ_NAME];
  createBullBoard({
    queues: queueNames.map((n) => new BullMQAdapter(getQueue(n))),
    serverAdapter,
  });

  logger.info({ basePath, queueNames }, '[bullboard] dashboard mounted');

  return {
    basePath,
    router: serverAdapter.getRouter() as unknown as Router,
    guards: [ipAllowlist(), adminSession(), requireRole('SUPER_ADMIN')],
  };
}
