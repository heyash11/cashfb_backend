import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearAllCollections,
  connectTestMongo,
  disconnectTestMongo,
} from '../../../test/testing/mongo.js';
import { MODELS } from '../../shared/models/index.js';
import { WebhookEventModel } from '../../shared/models/WebhookEvent.model.js';
import { WebhookService } from './webhooks.service.js';

type AnyModel = { syncIndexes(): Promise<string[]> };

const WEBHOOK_SECRET = 'unit-test-webhook-secret-xxxxx';

function signEvent(raw: string, secret = WEBHOOK_SECRET): string {
  return createHmac('sha256', secret).update(raw).digest('hex');
}

function buildEvent(
  eventType = 'payment.captured',
  extraPayload: object = {},
): { raw: Buffer; sig: string } {
  const event = {
    event: eventType,
    payload: {
      payment: {
        entity: {
          id: 'pay_test_1',
          order_id: 'order_test_1',
          amount: 50000,
          status: 'captured',
          ...extraPayload,
        },
      },
    },
  };
  const rawStr = JSON.stringify(event);
  return { raw: Buffer.from(rawStr, 'utf8'), sig: signEvent(rawStr) };
}

beforeAll(async () => {
  await connectTestMongo();
  await Promise.all(Object.values(MODELS).map((m) => (m as unknown as AnyModel).syncIndexes()));
}, 120_000);

afterAll(async () => {
  await disconnectTestMongo();
});

beforeEach(async () => {
  await clearAllCollections();
});

describe('WebhookService.handleRazorpayWebhook', () => {
  it('valid signature + fresh eventId → dispatches handler, row status DONE, 200', async () => {
    const dispatcher = vi.fn().mockResolvedValue(undefined);
    const svc = new WebhookService({
      webhookSecret: WEBHOOK_SECRET,
      dispatcher,
    });
    const { raw, sig } = buildEvent();

    const result = await svc.handleRazorpayWebhook(raw, sig, 'evt_fresh_1');

    expect(result).toEqual({ httpCode: 200, message: 'ok' });
    expect(dispatcher).toHaveBeenCalledTimes(1);

    const row = await WebhookEventModel.findOne({ eventId: 'evt_fresh_1' });
    expect(row?.status).toBe('DONE');
    expect(row?.processedAt).toBeInstanceOf(Date);
  });

  it('duplicate eventId (already DONE) → 200 "duplicate", handler NOT re-dispatched', async () => {
    const dispatcher = vi.fn().mockResolvedValue(undefined);
    const svc = new WebhookService({
      webhookSecret: WEBHOOK_SECRET,
      dispatcher,
    });
    const { raw, sig } = buildEvent();

    // First delivery: processes normally.
    await svc.handleRazorpayWebhook(raw, sig, 'evt_dup_1');
    expect(dispatcher).toHaveBeenCalledTimes(1);

    // Second delivery with same eventId.
    const second = await svc.handleRazorpayWebhook(raw, sig, 'evt_dup_1');
    expect(second).toEqual({ httpCode: 200, message: 'duplicate' });
    // Still 1 — no re-dispatch.
    expect(dispatcher).toHaveBeenCalledTimes(1);
  });

  it('invalid signature → 400 "invalid signature", no state change', async () => {
    const dispatcher = vi.fn().mockResolvedValue(undefined);
    const svc = new WebhookService({
      webhookSecret: WEBHOOK_SECRET,
      dispatcher,
    });
    const { raw } = buildEvent();

    const result = await svc.handleRazorpayWebhook(
      raw,
      signEvent(raw.toString('utf8'), 'wrong-secret'),
      'evt_bad_sig_1',
    );

    expect(result).toEqual({ httpCode: 400, message: 'invalid signature' });
    expect(dispatcher).not.toHaveBeenCalled();
    expect(await WebhookEventModel.countDocuments({ eventId: 'evt_bad_sig_1' })).toBe(0);
  });

  it('concurrent same-event dispatch → handler called exactly once', async () => {
    const dispatcher = vi.fn(() => new Promise<void>((resolve) => setTimeout(resolve, 50)));
    const svc = new WebhookService({
      webhookSecret: WEBHOOK_SECRET,
      dispatcher,
    });
    const { raw, sig } = buildEvent();

    const eventId = 'evt_concurrent_1';
    const results = await Promise.allSettled([
      svc.handleRazorpayWebhook(raw, sig, eventId),
      svc.handleRazorpayWebhook(raw, sig, eventId),
    ]);

    // Both calls resolve.
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);

    // Both responses 200. One 'ok', the other 'concurrent' or
    // 'duplicate' depending on whose finalise write landed first.
    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      expect(r.value.httpCode).toBe(200);
      expect(['ok', 'concurrent', 'duplicate']).toContain(r.value.message);
    }

    // Exactly one dispatcher call (the insert-winner).
    expect(dispatcher).toHaveBeenCalledTimes(1);

    const row = await WebhookEventModel.findOne({ eventId });
    expect(row?.status).toBe('DONE');
    expect(row?.attempts).toBe(0);
  });
});
