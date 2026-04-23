import type { Request, Response } from 'express';
import type { WebhookService } from './webhooks.service.js';

export class WebhooksController {
  constructor(private readonly service: WebhookService) {}

  /**
   * Raw-body handler. Mounted BEFORE `express.json()` so
   * `req.body` is the original Buffer (required for HMAC verify).
   */
  razorpay = async (req: Request, res: Response): Promise<void> => {
    const sig = req.header('X-Razorpay-Signature') ?? undefined;
    const eventId = req.header('X-Razorpay-Event-Id') ?? undefined;
    const raw = req.body as Buffer;
    const result = await this.service.handleRazorpayWebhook(raw, sig, eventId);
    res.status(result.httpCode).send(result.message);
  };
}
