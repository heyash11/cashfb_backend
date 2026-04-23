import express, { Router, type RequestHandler } from 'express';
import { WebhooksController } from './webhooks.controller.js';
import type { WebhookService } from './webhooks.service.js';

/**
 * Returns the raw-body middleware + the webhook handler. Mount the
 * POST `/webhooks/razorpay` route returned here BEFORE the app-wide
 * `express.json()` call so the payment provider's signed payload
 * reaches the handler as an unparsed Buffer.
 *
 * Per SECURITY.md §8, this route is rate-limiter-bypassed.
 */
export function createWebhooksRouter(service: WebhookService): Router {
  const router = Router();
  const controller = new WebhooksController(service);

  const rawBody: RequestHandler = express.raw({ type: 'application/json', limit: '1mb' });
  router.post('/webhooks/razorpay', rawBody, controller.razorpay);

  return router;
}
