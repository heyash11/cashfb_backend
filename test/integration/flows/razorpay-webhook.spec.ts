import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import request from 'supertest';
import { createApp } from '../../../src/app.js';
import { env } from '../../../src/config/env.js';
import { DonationModel } from '../../../src/shared/models/Donation.model.js';
import { WebhookEventModel } from '../../../src/shared/models/WebhookEvent.model.js';
import { connectHarness, disconnectHarness, resetFullState } from './_harness.js';

/**
 * Integration — Razorpay webhook round-trip. Fabricates a valid
 * HMAC signature against the configured secret, POSTs raw-body to
 * the real /api/v1/webhooks/razorpay endpoint, and asserts state
 * transitions persist through the full middleware chain (raw-body
 * parser → webhook service → DonationService).
 *
 * Regression guard for the raw-body invariant: app.ts mounts the
 * webhook router BEFORE express.json(). Any future re-order would
 * break HMAC validation because re-serialising parsed JSON
 * produces different bytes.
 */
function hmac(raw: string, secret: string): string {
  return createHmac('sha256', secret).update(raw).digest('hex');
}

beforeAll(async () => {
  await connectHarness();
}, 30_000);

afterAll(async () => {
  await disconnectHarness();
});

beforeEach(async () => {
  await resetFullState();
});

describe('[integration] razorpay webhook round-trip', () => {
  const app = createApp();

  it('valid-signature payment.captured → Donation.status CAPTURED + webhook_events row DONE', async () => {
    // Pre-seed the Donation in CREATED state so onCaptured has
    // something to flip.
    const razorpayOrderId = `order_${Date.now()}`;
    const razorpayPaymentId = `pay_${Date.now()}`;
    await DonationModel.create({
      userId: new Types.ObjectId(),
      amount: 10_000,
      razorpayOrderId,
      status: 'CREATED',
    });

    const eventId = `evt_${Date.now()}`;
    const body = {
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: razorpayPaymentId,
            order_id: razorpayOrderId,
            amount: 10_000,
            currency: 'INR',
            status: 'captured',
            notes: {},
          },
        },
      },
    };
    const rawBody = JSON.stringify(body);
    const secret = env.RAZORPAY_WEBHOOK_SECRET ?? 'dev-webhook-secret-placeholder';
    const signature = hmac(rawBody, secret);

    const res = await request(app)
      .post('/api/v1/webhooks/razorpay')
      .set('x-razorpay-signature', signature)
      .set('x-razorpay-event-id', eventId)
      .set('Content-Type', 'application/json')
      .send(rawBody);

    expect(res.status).toBe(200);

    const donation = await DonationModel.findOne({ razorpayOrderId });
    expect(donation?.status).toBe('CAPTURED');

    const webhookRow = await WebhookEventModel.findOne({ eventId });
    expect(webhookRow).toBeTruthy();
    expect(webhookRow?.status).toBe('DONE');
  });

  it('invalid-signature request returns 400 without writing webhook_events', async () => {
    const res = await request(app)
      .post('/api/v1/webhooks/razorpay')
      .set('x-razorpay-signature', 'totally-bogus-signature')
      .set('x-razorpay-event-id', 'evt_bogus_1')
      .set('Content-Type', 'application/json')
      .send('{"event":"payment.captured","payload":{}}');

    expect(res.status).toBe(400);
    const row = await WebhookEventModel.findOne({ eventId: 'evt_bogus_1' });
    expect(row).toBeNull();
  });
});
