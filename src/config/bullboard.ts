import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import type { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import { env } from './env.js';
import { logger } from './logger.js';
import { getQueue } from './queues.js';
import { QUEUES } from '../workers/_registry.js';

/**
 * Bull-board dashboard mounted at `env.BULL_DASHBOARD_PATH`
 * (default `/admin/queues`). Provides queue + job inspection,
 * retry-from-dashboard, and DLQ visibility.
 *
 * Placeholder RBAC: Phase 7 ships a simple JWT + SUPER_ADMIN-role
 * check. TODO(phase-8): Phase 8 replaces this with the full admin
 * middleware stack (IP allowlist + audit-log middleware + per-
 * action RBAC via `actorId` on every write). The placeholder is
 * deliberately light to avoid coupling Phase 7 to admin-surface
 * work.
 */

interface AccessClaimsWithRole {
  sub: string;
  role?: string;
}

function requireSuperAdmin(req: Request, res: Response, next: NextFunction): void {
  // Request.user is populated by `requireUser` middleware in the
  // normal HTTP flow. For Bull-board we mount a relaxed guard that
  // reads the claim directly if present. Phase 8's real middleware
  // will handle JWT verification, IP allowlist, audit-log.
  const user = req.user as AccessClaimsWithRole | undefined;
  if (!user || user.role !== 'SUPER_ADMIN') {
    res.status(401).json({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Bull-board requires SUPER_ADMIN role' },
    });
    return;
  }
  next();
}

export interface BullBoardMount {
  basePath: string;
  router: Router;
  guard: RequestHandler;
}

export function buildBullBoard(): BullBoardMount {
  const serverAdapter = new ExpressAdapter();
  const basePath = env.BULL_DASHBOARD_PATH;
  serverAdapter.setBasePath(basePath);

  // Surface every known queue — the registry reflects what workers
  // actually wire. DLQ included so operators can inspect exhausted
  // jobs without a separate tool.
  const queueNames = [QUEUES.CRON, QUEUES.INVOICE, QUEUES.WEBHOOK_RETRY, env.BULL_DLQ_NAME];
  createBullBoard({
    queues: queueNames.map((n) => new BullMQAdapter(getQueue(n))),
    serverAdapter,
  });

  logger.info({ basePath, queueNames }, '[bullboard] dashboard mounted');

  return {
    basePath,
    router: serverAdapter.getRouter() as unknown as Router,
    guard: requireSuperAdmin,
  };
}
