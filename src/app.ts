import express, { type Express, type Request, type Response } from 'express';
import { env } from './config/env.js';
import { DonationService } from './modules/donations/donations.service.js';
import { SubscriptionService } from './modules/subscriptions/subscriptions.service.js';
import { createWebhooksRouter } from './modules/webhooks/webhooks.routes.js';
import { WebhookService } from './modules/webhooks/webhooks.service.js';
import { InvoiceServiceStub } from './shared/invoicing/invoice.stub.js';

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
  const subscriptionService = new SubscriptionService({
    invoiceService: new InvoiceServiceStub(),
  });
  const webhookService = new WebhookService({ donationService, subscriptionService });
  app.use('/api/v1', createWebhooksRouter(webhookService));

  app.use(express.json({ limit: '1mb' }));

  return app;
}
