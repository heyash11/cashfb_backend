import express, { type Express, type Request, type Response } from 'express';
import { buildBullBoard } from './config/bullboard.js';
import { env } from './config/env.js';
import { AdminAuthService, createAdminAuthRouter } from './modules/admin-auth/index.js';
import { DonationService } from './modules/donations/donations.service.js';
import { RefundService } from './modules/refunds/refunds.service.js';
import { SubscriptionService } from './modules/subscriptions/subscriptions.service.js';
import { createWebhooksRouter } from './modules/webhooks/webhooks.routes.js';
import { WebhookService } from './modules/webhooks/webhooks.service.js';

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

  // Bull-board dashboard. Skipped in test env — each call opens
  // BullMQ Queues against Redis, which would block integration
  // tests that just exercise the Express app. Workers (and
  // therefore production bull-board) run in the separate
  // `src/worker.ts` process in real deployments.
  if (env.NODE_ENV !== 'test') {
    const bullboard = buildBullBoard();
    app.use(bullboard.basePath, ...bullboard.guards, bullboard.router);
  }

  return app;
}
