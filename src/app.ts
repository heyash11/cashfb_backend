import * as Sentry from '@sentry/node';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { buildBullBoard } from './config/bullboard.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import {
  AdminAdminUsersService,
  createAdminAdminUsersRouter,
} from './modules/admin-admin-users/index.js';
import {
  AdminAdsConfigService,
  createAdminAdsConfigRouter,
} from './modules/admin-ads-config/index.js';
import {
  AdminAppConfigService,
  createAdminAppConfigRouter,
} from './modules/admin-app-config/index.js';
import {
  AdminAuditLogsService,
  createAdminAuditLogsRouter,
} from './modules/admin-audit-logs/index.js';
import { AdminAuthService, createAdminAuthRouter } from './modules/admin-auth/index.js';
import { AdminCmsService, createAdminCmsRouter } from './modules/admin-cms/index.js';
import { createAdminCustomRoomsRouter } from './modules/admin-custom-rooms/index.js';
import {
  AdminDashboardService,
  createAdminDashboardRouter,
} from './modules/admin-dashboard/index.js';
import { AdminDlqService, createAdminDlqRouter } from './modules/admin-dlq/index.js';
import { createAdminDonationsRouter } from './modules/admin-donations/index.js';
import {
  AdminNotificationsService,
  createAdminNotificationsRouter,
} from './modules/admin-notifications/index.js';
import { createAdminPostsRouter } from './modules/admin-posts/index.js';
import {
  AdminPrizePoolsService,
  createAdminPrizePoolsRouter,
} from './modules/admin-prize-pools/index.js';
import { createAdminRedeemCodesRouter } from './modules/admin-redeem-codes/index.js';
import { createAdminRefundsRouter } from './modules/admin-refunds/index.js';
import { AdminSponsorsService, createAdminSponsorsRouter } from './modules/admin-sponsors/index.js';
import { createAdminSubscriptionsRouter } from './modules/admin-subscriptions/index.js';
import { AdminUsersService, createAdminUsersRouter } from './modules/admin-users/index.js';
import { AdminCustomRoomsService } from './modules/custom-rooms/custom-rooms.admin.service.js';
import { AdminDonationService } from './modules/donations/donations.admin.service.js';
import { DonationService } from './modules/donations/donations.service.js';
import { AdminPostService } from './modules/posts/posts.admin.service.js';
import { PrizePoolService } from './modules/prize-pools/prize-pools.service.js';
import { AdminRedeemCodeService } from './modules/redeem-codes/redeem-codes.admin.service.js';
import { RefundService } from './modules/refunds/refunds.service.js';
import { AdminSubscriptionService } from './modules/subscriptions/subscriptions.admin.service.js';
import { SubscriptionService } from './modules/subscriptions/subscriptions.service.js';
import { createWebhooksRouter } from './modules/webhooks/webhooks.routes.js';
import { WebhookService } from './modules/webhooks/webhooks.service.js';
import { ZodError } from 'zod';
import { AppError } from './shared/errors/AppError.js';

export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');

  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      ts: new Date().toISOString(),
      uptime: Math.floor(process.uptime()),
      env: env.NODE_ENV,
    });
  });

  // CRITICAL ORDER: the raw-body webhook MUST be mounted BEFORE any
  // `express.json()` middleware. Razorpay signs the unparsed request
  // body, and re-serialising a JSON-parsed body produces a different
  // byte sequence — the HMAC then fails. PAYMENTS.md §5.
  const donationService = new DonationService();
  // Invoice generation moved out of the critical path in Phase 7 —
  // SubscriptionService.onCharged enqueues an `invoice-generate`
  // BullMQ job; the worker (src/worker.ts) runs the real
  // InvoiceService against Redis-reachable infra.
  const subscriptionService = new SubscriptionService();
  const refundService = new RefundService();
  const webhookService = new WebhookService({
    donationService,
    subscriptionService,
    refundService,
  });
  app.use('/api/v1', createWebhooksRouter(webhookService));

  app.use(express.json({ limit: '1mb' }));

  // Admin auth surface. Middleware chain order (enforced per-route):
  //   rate-limit → ipAllowlist → adminSession → csrfCheck → requireRole → auditLog → handler
  // Only login + logout bypass the full chain — see admin-auth.routes.
  const adminAuthService = new AdminAuthService();
  app.use('/api/v1/admin/auth', createAdminAuthRouter(adminAuthService));

  // Chunk 2 admin surface. Each router applies its own middleware
  // chain (ipAllowlist → adminSession → csrfCheck → requireAnyRole
  // → auditLog). Services are instantiated with default deps;
  // refundService is shared with the webhook router above so the
  // admin-initiated refund path and the webhook-received refund
  // path see the same Razorpay client and the same repos.
  const adminPostService = new AdminPostService();
  const adminRedeemCodeService = new AdminRedeemCodeService();
  const adminDonationService = new AdminDonationService();
  const adminSubscriptionService = new AdminSubscriptionService();
  const adminCustomRoomsService = new AdminCustomRoomsService();
  app.use('/api/v1/admin/posts', createAdminPostsRouter(adminPostService));
  app.use('/api/v1/admin/redeem-codes', createAdminRedeemCodesRouter(adminRedeemCodeService));
  app.use('/api/v1/admin/donations', createAdminDonationsRouter(adminDonationService));
  app.use('/api/v1/admin/subscriptions', createAdminSubscriptionsRouter(adminSubscriptionService));
  app.use('/api/v1/admin/custom-rooms', createAdminCustomRoomsRouter(adminCustomRoomsService));
  app.use('/api/v1/admin/refunds', createAdminRefundsRouter(refundService));

  // Chunk 3a admin surface. admin-prize-pools needs both its own
  // service (list + payout ledger) and the Phase 6 PrizePoolService
  // (manual trigger). admin-dlq uses the BullMQ DLQ queue + the
  // dlq_audit Mongo sidecar. admin-dashboard is Redis-cached with
  // a 60s TTL (no active invalidation).
  const adminUsersService = new AdminUsersService();
  const adminPrizePoolsService = new AdminPrizePoolsService();
  const prizePoolCoreService = new PrizePoolService();
  const adminDashboardService = new AdminDashboardService();
  const adminDlqService = new AdminDlqService();
  app.use('/api/v1/admin/users', createAdminUsersRouter(adminUsersService));
  app.use(
    '/api/v1/admin/prize-pools',
    createAdminPrizePoolsRouter(adminPrizePoolsService, prizePoolCoreService),
  );
  app.use('/api/v1/admin/dashboard', createAdminDashboardRouter(adminDashboardService));
  app.use('/api/v1/admin/dlq', createAdminDlqRouter(adminDlqService));

  // Chunk 3b admin surface — config plumbing. Each router owns a
  // narrow resource (cms content, ad placements, sponsors, audit
  // logs, admin users, app config) plus the broadcast fan-out for
  // notifications. Role gates are per-router; the middleware chain
  // is applied inside each router factory.
  const adminCmsService = new AdminCmsService();
  const adminAdsConfigService = new AdminAdsConfigService();
  const adminSponsorsService = new AdminSponsorsService();
  const adminNotificationsService = new AdminNotificationsService();
  const adminAuditLogsService = new AdminAuditLogsService();
  const adminAdminUsersService = new AdminAdminUsersService();
  const adminAppConfigService = new AdminAppConfigService();
  app.use('/api/v1/admin/cms', createAdminCmsRouter(adminCmsService));
  app.use('/api/v1/admin/ads-config', createAdminAdsConfigRouter(adminAdsConfigService));
  app.use('/api/v1/admin/sponsors', createAdminSponsorsRouter(adminSponsorsService));
  app.use('/api/v1/admin/notifications', createAdminNotificationsRouter(adminNotificationsService));
  app.use('/api/v1/admin/audit-logs', createAdminAuditLogsRouter(adminAuditLogsService));
  app.use('/api/v1/admin/admins', createAdminAdminUsersRouter(adminAdminUsersService));
  app.use('/api/v1/admin/app-config', createAdminAppConfigRouter(adminAppConfigService));

  // Bull-board dashboard. Skipped in test env — each call opens
  // BullMQ Queues against Redis, which would block integration
  // tests that just exercise the Express app. Workers (and
  // therefore production bull-board) run in the separate
  // `src/worker.ts` process in real deployments.
  if (env.NODE_ENV !== 'test') {
    const bullboard = buildBullBoard();
    app.use(bullboard.basePath, ...bullboard.guards, bullboard.router);
  }

  // Global error handler. MUST stay last — Express recognises this as
  // error middleware by its 4-argument signature. AppError subclasses
  // render with their configured httpStatus + code; any other throw
  // is logged with stack and returns a generic 500 envelope. Stacks
  // are never leaked to clients (even in dev) — logs are source of
  // truth. CONVENTIONS.md §Errors.
  app.use((err: unknown, req: Request, res: Response, next: NextFunction): void => {
    if (res.headersSent) {
      next(err);
      return;
    }
    if (err instanceof AppError) {
      // 5xx AppError subclasses are genuine server faults — surface
      // to Sentry. 4xx AppError instances are client faults and are
      // filtered by instrument.ts's beforeSend anyway; we still hand
      // them to captureException because the Sentry-side filter keeps
      // the rule in one place instead of duplicating httpStatus logic.
      if (err.httpStatus >= 500) {
        Sentry.captureException(err, {
          tags: { code: err.code, httpStatus: String(err.httpStatus) },
          extra: { method: req.method, path: req.path, reqId: req.id },
        });
      }
      res.status(err.httpStatus).json({
        success: false,
        error: {
          code: err.code,
          message: err.message,
          ...(err.details ? { details: err.details } : {}),
        },
      });
      return;
    }
    if (err instanceof ZodError) {
      // Controllers call `schema.parse(req.body)` throughout the
      // admin surface. Surface these as 400 VALIDATION_FAILED with
      // the Zod issue list in details rather than hitting the 500
      // fallback. Not Sentry-worthy — client fault.
      res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Request validation failed',
          details: { issues: err.issues },
        },
      });
      return;
    }
    // Non-AppError unknowns — genuine crashes. Always surface to Sentry.
    Sentry.captureException(err, {
      extra: { method: req.method, path: req.path, reqId: req.id },
    });
    const e = err as { message?: string; stack?: string };
    logger.error(
      {
        err: { message: e.message, stack: e.stack },
        method: req.method,
        path: req.path,
        reqId: req.id,
      },
      '[api] unhandled error',
    );
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL', message: 'Internal server error' },
    });
  });

  return app;
}
