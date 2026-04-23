import { Router } from 'express';
import { adminSession } from '../../shared/middleware/admin-session.js';
import { auditLog } from '../../shared/middleware/audit-log.js';
import { csrfCheck } from '../../shared/middleware/csrf.js';
import { ipAllowlist } from '../../shared/middleware/ip-allowlist.js';
import { requireAnyRole } from '../../shared/middleware/require-role.js';
import type { PrizePoolService } from '../prize-pools/prize-pools.service.js';
import { AdminPrizePoolsController } from './admin-prize-pools.controller.js';
import type { AdminPrizePoolsService } from './admin-prize-pools.service.js';

/**
 * Mounted at /api/v1/admin/prize-pools.
 *   GET  /                          — PAYMENT or SUPER (list pools)
 *   POST /run                       — SUPER only (manual trigger override)
 *   GET  /winners                   — PAYMENT or SUPER (winner ledger)
 *   POST /winners/:id/mark-payout   — PAYMENT or SUPER (financial state flip)
 */
export function createAdminPrizePoolsRouter(
  service: AdminPrizePoolsService,
  coreService: PrizePoolService,
): Router {
  const router = Router();
  const controller = new AdminPrizePoolsController(service, coreService);

  const baseChain = [ipAllowlist(), adminSession(), csrfCheck()] as const;
  const paymentOrSuper = requireAnyRole('PAYMENT_ADMIN', 'SUPER_ADMIN');
  const superOnly = requireAnyRole('SUPER_ADMIN');

  router.get('/', ...baseChain, paymentOrSuper, controller.list);
  router.post(
    '/run',
    ...baseChain,
    superOnly,
    auditLog({ action: 'PRIZE_POOL_RUN', resourceKind: 'PrizePool' }, controller.run),
  );
  router.get('/winners', ...baseChain, paymentOrSuper, controller.listWinners);
  router.post(
    '/winners/:id/mark-payout',
    ...baseChain,
    paymentOrSuper,
    auditLog(
      { action: 'PRIZE_POOL_WINNER_MARK_PAYOUT', resourceKind: 'PrizePoolWinner' },
      controller.markPayout,
    ),
  );

  return router;
}
