import { Types } from 'mongoose';
import type Razorpay from 'razorpay';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearAllCollections,
  connectTestMongo,
  disconnectTestMongo,
} from '../../../test/testing/mongo.js';
import { MODELS } from '../../shared/models/index.js';
import { SubscriptionModel } from '../../shared/models/Subscription.model.js';
import { SubscriptionPaymentModel } from '../../shared/models/SubscriptionPayment.model.js';
import { RefundService } from './refunds.service.js';

type AnyModel = { syncIndexes(): Promise<string[]> };

interface FakeRzp {
  rzp: Razorpay;
  refundSpy: ReturnType<typeof vi.fn>;
  cancelSpy: ReturnType<typeof vi.fn>;
}
function mkFakeRzp(refundId = 'rfnd_test_1'): FakeRzp {
  const refundSpy = vi.fn(async (_paymentId: string, _params: Record<string, unknown>) => ({
    id: refundId,
    payment_id: _paymentId,
    amount: (_params['amount'] as number | undefined) ?? 5900,
    status: 'processed',
  }));
  const cancelSpy = vi.fn(async (_id: string, _flag?: boolean | number) => ({
    id: _id,
    status: 'cancelled',
  }));
  const rzp = {
    payments: { refund: refundSpy },
    subscriptions: { cancel: cancelSpy },
  } as unknown as Razorpay;
  return { rzp, refundSpy, cancelSpy };
}

async function seedPaymentAndSubscription(): Promise<{
  paymentId: Types.ObjectId;
  subscriptionId: Types.ObjectId;
  razorpayPaymentId: string;
  razorpaySubscriptionId: string;
}> {
  const userId = new Types.ObjectId();
  const sub = await SubscriptionModel.create({
    userId,
    tier: 'PRO',
    razorpaySubscriptionId: 'sub_rf_1',
    razorpayPlanId: 'plan_test_PRO',
    status: 'ACTIVE',
    billingCycle: 'MONTHLY',
    paidCount: 1,
    autoRenew: true,
  });
  const payment = await SubscriptionPaymentModel.create({
    subscriptionId: sub._id,
    userId,
    razorpayPaymentId: 'pay_rf_1',
    amount: 5900,
    sacCode: '998439',
    status: 'CAPTURED',
    capturedAt: new Date(),
  });
  return {
    paymentId: payment._id,
    subscriptionId: sub._id,
    razorpayPaymentId: 'pay_rf_1',
    razorpaySubscriptionId: 'sub_rf_1',
  };
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

describe('RefundService.initiateRefund', () => {
  it('calls rzp.payments.refund with speed=normal + notes, then rzp.subscriptions.cancel(id, false), returns refund id', async () => {
    const fake = mkFakeRzp('rfnd_happy_1');
    const svc = new RefundService({ razorpay: fake.rzp });
    const { paymentId, razorpayPaymentId, razorpaySubscriptionId } =
      await seedPaymentAndSubscription();
    const actorId = new Types.ObjectId();

    const result = await svc.initiateRefund({
      paymentId,
      reason: 'user requested',
      actorId,
    });

    expect(result).toEqual({ razorpayRefundId: 'rfnd_happy_1' });
    expect(fake.refundSpy).toHaveBeenCalledTimes(1);
    const [pid, params] = fake.refundSpy.mock.calls[0] ?? [];
    expect(pid).toBe(razorpayPaymentId);
    expect(params).toMatchObject({
      speed: 'normal',
      notes: { reason: 'user requested', actorId: String(actorId) },
    });
    // No amount param → full refund.
    expect(params).not.toHaveProperty('amount');

    expect(fake.cancelSpy).toHaveBeenCalledWith(razorpaySubscriptionId, false);
  });

  it('cancelSubscription: false skips rzp.subscriptions.cancel', async () => {
    const fake = mkFakeRzp('rfnd_nocancel_1');
    const svc = new RefundService({ razorpay: fake.rzp });
    const { paymentId } = await seedPaymentAndSubscription();

    await svc.initiateRefund({
      paymentId,
      reason: 'goodwill',
      actorId: new Types.ObjectId(),
      cancelSubscription: false,
    });

    expect(fake.refundSpy).toHaveBeenCalledTimes(1);
    expect(fake.cancelSpy).not.toHaveBeenCalled();
  });
});

describe('RefundService.onRefundProcessed', () => {
  it('flips payment to REFUNDED with refundedAt + refundAmount; second delivery is a no-op (status predicate)', async () => {
    const fake = mkFakeRzp();
    const svc = new RefundService({
      razorpay: fake.rzp,
      clock: () => new Date('2026-04-23T10:00:00Z'),
    });
    const { paymentId, razorpayPaymentId } = await seedPaymentAndSubscription();

    await svc.onRefundProcessed({
      refund: {
        entity: { id: 'rfnd_w_1', payment_id: razorpayPaymentId, amount: 5900 },
      },
    });

    const after = await SubscriptionPaymentModel.findById(paymentId);
    expect(after?.status).toBe('REFUNDED');
    expect(after?.refundAmount).toBe(5900);
    expect(after?.refundedAt?.toISOString()).toBe('2026-04-23T10:00:00.000Z');

    // Second delivery (e.g. Razorpay retry) with a different refund
    // id for the same payment — the status predicate blocks the
    // update so refundedAt doesn't shift.
    await svc.onRefundProcessed({
      refund: {
        entity: { id: 'rfnd_w_2_dup', payment_id: razorpayPaymentId, amount: 5900 },
      },
    });
    const stillAfter = await SubscriptionPaymentModel.findById(paymentId);
    expect(stillAfter?.status).toBe('REFUNDED');
    expect(stillAfter?.refundedAt?.toISOString()).toBe('2026-04-23T10:00:00.000Z');
  });
});
