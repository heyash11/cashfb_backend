import { createHmac } from 'node:crypto';
import type { Types } from 'mongoose';
import type Razorpay from 'razorpay';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearAllCollections,
  connectTestMongo,
  disconnectTestMongo,
} from '../../../test/testing/mongo.js';
// Phase 7: invoice generation moved to the BullMQ `invoice` queue.
// Tests spy on the enqueueInvoice dep rather than an InvoiceService
// instance so we never open Redis and never exercise the PDF/S3/SES
// pipeline. The invoice worker's own spec covers end-to-end
// generation.
import { AppConfigModel } from '../../shared/models/AppConfig.model.js';
import { MODELS } from '../../shared/models/index.js';
import { SubscriptionModel } from '../../shared/models/Subscription.model.js';
import { SubscriptionPaymentModel } from '../../shared/models/SubscriptionPayment.model.js';
import { UserModel, type UserAttrs, type UserDoc } from '../../shared/models/User.model.js';
import { UserRepository } from '../../shared/repositories/User.repository.js';
import { SubscriptionService, type Tier } from './subscriptions.service.js';

type AnyModel = { syncIndexes(): Promise<string[]> };

const KEY_SECRET = 'sub-test-secret-0000';

let phoneCounter = 0;
async function mkUser(overrides: Partial<UserAttrs> = {}): Promise<UserDoc> {
  phoneCounter += 1;
  const suffix = String(phoneCounter).padStart(8, '0');
  return UserModel.create({
    phone: `+9199${suffix}`,
    dob: new Date('1995-01-01'),
    declaredState: 'IN-MH',
    ...overrides,
  });
}

async function seedPlans(): Promise<void> {
  await AppConfigModel.updateOne(
    { key: 'default' },
    {
      $set: {
        razorpayPlanIds: { PRO: 'plan_test_PRO', PRO_MAX: 'plan_test_PROMAX' },
      },
    },
    { upsert: true },
  );
}

interface FakeRzpHandles {
  rzp: Razorpay;
  createSub: ReturnType<typeof vi.fn>;
  cancelSub: ReturnType<typeof vi.fn>;
}
function mkFakeRazorpay(subId = 'sub_test_1'): FakeRzpHandles {
  const createSub = vi.fn(async () => ({ id: subId, status: 'created' }));
  const cancelSub = vi.fn(async (_id: string, _flag?: boolean | number) => ({
    id: _id,
    status: 'cancelled',
  }));
  const rzp = {
    subscriptions: { create: createSub, cancel: cancelSub },
  } as unknown as Razorpay;
  return { rzp, createSub, cancelSub };
}

function mkSvc(deps: Partial<ConstructorParameters<typeof SubscriptionService>[0]> = {}): {
  svc: SubscriptionService;
  enqueueSpy: ReturnType<typeof vi.fn>;
  fakeRzp: FakeRzpHandles;
} {
  const fakeRzp = mkFakeRazorpay();
  const enqueueSpy = vi.fn<(payload: { paymentId: string }) => Promise<void>>(
    async () => undefined,
  );
  const svc = new SubscriptionService({
    razorpay: fakeRzp.rzp,
    keySecret: KEY_SECRET,
    enqueueInvoice: enqueueSpy,
    ...deps,
  });
  return { svc, enqueueSpy, fakeRzp };
}

async function seedSubscription(
  userId: Types.ObjectId,
  tier: Tier,
  overrides: { razorpaySubscriptionId?: string } = {},
) {
  return SubscriptionModel.create({
    userId,
    tier,
    razorpaySubscriptionId: overrides.razorpaySubscriptionId ?? 'sub_fix_1',
    razorpayPlanId: `plan_test_${tier}`,
    status: 'ACTIVE',
    billingCycle: 'MONTHLY',
    paidCount: 1,
    autoRenew: true,
  });
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

describe('SubscriptionService.listPlans', () => {
  it('returns Pro (5900=5000+900) and Pro Max (11800=10000+1800) with plan IDs from app_config', async () => {
    await seedPlans();
    const { svc } = mkSvc();

    const plans = await svc.listPlans();

    expect(plans).toHaveLength(2);
    const pro = plans.find((p) => p.tier === 'PRO');
    const proMax = plans.find((p) => p.tier === 'PRO_MAX');
    expect(pro).toMatchObject({
      razorpayPlanId: 'plan_test_PRO',
      baseAmount: 5000,
      gstAmount: 900,
      totalAmount: 5900,
      billingCycle: 'MONTHLY',
    });
    expect(proMax).toMatchObject({
      razorpayPlanId: 'plan_test_PROMAX',
      baseAmount: 10000,
      gstAmount: 1800,
      totalAmount: 11800,
    });
  });
});

describe('SubscriptionService.create', () => {
  it('looks up plan id, calls razorpay.subscriptions.create, persists Subscription with CREATED status', async () => {
    await seedPlans();
    const { svc, fakeRzp } = mkSvc();
    const user = await mkUser();

    const result = await svc.create({ userId: user._id, tier: 'PRO' });

    expect(result.subscriptionId).toBe('sub_test_1');
    expect(fakeRzp.createSub).toHaveBeenCalledWith(
      expect.objectContaining({ plan_id: 'plan_test_PRO', customer_notify: 1 }),
    );

    const sub = await SubscriptionModel.findOne({ razorpaySubscriptionId: 'sub_test_1' });
    expect(sub?.status).toBe('CREATED');
    expect(sub?.tier).toBe('PRO');
    expect(sub?.razorpayPlanId).toBe('plan_test_PRO');
    expect(sub?.baseAmount).toBe(5000);
    expect(sub?.gstAmount).toBe(900);
    expect(sub?.totalAmount).toBe(5900);
    expect(String(sub?.userId)).toBe(String(user._id));
  });
});

describe('SubscriptionService.verify', () => {
  it('accepts a valid signature using the payment|subscription order (different from donation order|payment)', async () => {
    const { svc } = mkSvc();
    const paymentId = 'pay_v_1';
    const subId = 'sub_v_1';
    const sig = createHmac('sha256', KEY_SECRET).update(`${paymentId}|${subId}`).digest('hex');

    const result = await svc.verify({
      razorpay_payment_id: paymentId,
      razorpay_subscription_id: subId,
      razorpay_signature: sig,
    });
    expect(result).toEqual({ tentativeStatus: 'PENDING_WEBHOOK' });
  });

  it('throws INVALID_SIGNATURE when HMAC does not match', async () => {
    const { svc } = mkSvc();
    await expect(
      svc.verify({
        razorpay_payment_id: 'pay_x',
        razorpay_subscription_id: 'sub_x',
        razorpay_signature: 'a'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_SIGNATURE' });
  });
});

describe('SubscriptionService.cancel', () => {
  it('calls rzp.subscriptions.cancel with the cancel_at_cycle_end flag and sets local cancelledAt', async () => {
    const { svc, fakeRzp } = mkSvc();
    const user = await mkUser();
    const sub = await seedSubscription(user._id, 'PRO');

    await svc.cancel({ userId: user._id, subscriptionId: sub._id, atCycleEnd: true });

    expect(fakeRzp.cancelSub).toHaveBeenCalledWith('sub_fix_1', true);
    const after = await SubscriptionModel.findById(sub._id);
    expect(after?.cancelledAt).toBeInstanceOf(Date);
    // atCycleEnd=true does NOT flip local status to CANCELLED — the
    // webhook does that when Razorpay emits subscription.cancelled.
    expect(after?.status).toBe('ACTIVE');
  });

  it("rejects with FORBIDDEN when cancelling another user's subscription", async () => {
    const { svc } = mkSvc();
    const alice = await mkUser();
    const bob = await mkUser();
    const sub = await seedSubscription(alice._id, 'PRO');

    await expect(
      svc.cancel({ userId: bob._id, subscriptionId: sub._id, atCycleEnd: true }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('SubscriptionService webhook: subscription.charged', () => {
  it('creates SubscriptionPayment, increments paidCount, upgrades tier, sets tierExpiresAt, enqueues invoice job', async () => {
    // Phase 7: invoice generation is async. onCharged enqueues a
    // BullMQ job instead of running the PDF/S3/SES pipeline inline.
    // The payment row does NOT have invoiceNumber/invoicePdfUrl
    // immediately after onCharged — the worker populates those
    // fields. Test asserts tier + payment + counter + enqueue shape.
    const { svc, enqueueSpy } = mkSvc();
    const user = await mkUser({ tier: 'PUBLIC' });
    const sub = await seedSubscription(user._id, 'PRO', {
      razorpaySubscriptionId: 'sub_charged_1',
    });

    const currentEndSec = Math.floor(new Date('2026-05-23T00:00:00Z').getTime() / 1000);

    await svc.onCharged({
      subscription: {
        entity: {
          id: 'sub_charged_1',
          status: 'active',
          current_start: Math.floor(new Date('2026-04-23T00:00:00Z').getTime() / 1000),
          current_end: currentEndSec,
          paid_count: 2,
        },
      },
      payment: {
        entity: {
          id: 'pay_charged_1',
          order_id: 'order_c1',
          invoice_id: 'inv_c1',
          amount: 5900,
          method: 'card',
          status: 'captured',
        },
      },
    });

    const payment = await SubscriptionPaymentModel.findOne({ razorpayPaymentId: 'pay_charged_1' });
    expect(payment).toBeTruthy();
    expect(payment?.amount).toBe(5900);
    expect(payment?.status).toBe('CAPTURED');
    // Invoice fields are NOT populated by onCharged — worker does that.
    expect(payment?.invoiceNumber).toBeUndefined();
    expect(payment?.invoicePdfUrl).toBeUndefined();

    const afterSub = await SubscriptionModel.findById(sub._id);
    expect(afterSub?.paidCount).toBe(2);
    expect(afterSub?.status).toBe('ACTIVE');

    const afterUser = await UserModel.findById(user._id);
    expect(afterUser?.tier).toBe('PRO');
    expect(afterUser?.tierExpiresAt?.toISOString()).toBe(
      new Date(currentEndSec * 1000).toISOString(),
    );

    // enqueueInvoice called once with the new payment's _id
    // stringified (BullMQ JSON-serializes data; ObjectIds don't
    // round-trip, so the helper must stringify at the boundary).
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    const [arg] = enqueueSpy.mock.calls[0] ?? [];
    expect(arg).toEqual({ paymentId: String(payment?._id) });
  });

  it('rolls back cleanly when user update fails mid-transaction (no payment row, no paidCount bump, tier unchanged)', async () => {
    const { svc, enqueueSpy } = mkSvc();
    const user = await mkUser({ tier: 'PUBLIC' });
    const sub = await seedSubscription(user._id, 'PRO', {
      razorpaySubscriptionId: 'sub_rb_1',
    });

    // Force the user-update step to throw on first call. The
    // transaction must abort and roll back the SubscriptionPayment
    // insert + Subscription status/paidCount update.
    const spy = vi
      .spyOn(UserRepository.prototype, 'updateOne')
      .mockRejectedValueOnce(new Error('simulated user update failure'));

    await expect(
      svc.onCharged({
        subscription: {
          entity: {
            id: 'sub_rb_1',
            status: 'active',
            current_end: Math.floor(new Date('2026-05-23T00:00:00Z').getTime() / 1000),
            paid_count: 2,
          },
        },
        payment: {
          entity: {
            id: 'pay_rb_1',
            amount: 5900,
            status: 'captured',
          },
        },
      }),
    ).rejects.toThrow(/simulated user update failure/);

    // No SubscriptionPayment row was committed.
    expect(await SubscriptionPaymentModel.countDocuments({ razorpayPaymentId: 'pay_rb_1' })).toBe(
      0,
    );

    // Subscription paidCount + status unchanged.
    const subAfter = await SubscriptionModel.findById(sub._id);
    expect(subAfter?.paidCount).toBe(1); // seed value
    expect(subAfter?.status).toBe('ACTIVE'); // seed value

    // User tier unchanged.
    const userAfter = await UserModel.findById(user._id);
    expect(userAfter?.tier).toBe('PUBLIC');
    expect(userAfter?.tierExpiresAt).toBeUndefined();

    // Enqueue never called — we aborted before the post-transaction
    // side-effect window.
    expect(enqueueSpy).not.toHaveBeenCalled();

    spy.mockRestore();
  });
});

describe('SubscriptionService webhook: subscription.halted', () => {
  it('downgrades user to PUBLIC immediately and sets tierExpiresAt to now', async () => {
    const fixedNow = new Date('2026-04-23T10:00:00Z');
    const { svc } = mkSvc({ clock: () => fixedNow });
    const user = await mkUser({ tier: 'PRO', tierExpiresAt: new Date('2026-05-23T00:00:00Z') });
    await seedSubscription(user._id, 'PRO', { razorpaySubscriptionId: 'sub_halt_1' });

    await svc.onHalted({ subscription: { entity: { id: 'sub_halt_1' } } });

    const after = await UserModel.findById(user._id);
    expect(after?.tier).toBe('PUBLIC');
    expect(after?.tierExpiresAt?.toISOString()).toBe(fixedNow.toISOString());
  });
});

describe('SubscriptionService webhook: subscription.cancelled', () => {
  it('cancel_at_cycle_end=1 → user tier + tierExpiresAt unchanged (persists to cycle end)', async () => {
    const { svc } = mkSvc();
    const originalExpiry = new Date('2026-05-23T00:00:00Z');
    const user = await mkUser({ tier: 'PRO', tierExpiresAt: originalExpiry });
    await seedSubscription(user._id, 'PRO', { razorpaySubscriptionId: 'sub_cx_end_1' });

    await svc.onCancelled({
      subscription: {
        entity: {
          id: 'sub_cx_end_1',
          notes: { cancel_at_cycle_end: 1 },
        },
      },
    });

    const after = await UserModel.findById(user._id);
    expect(after?.tier).toBe('PRO');
    expect(after?.tierExpiresAt?.toISOString()).toBe(originalExpiry.toISOString());

    const sub = await SubscriptionModel.findOne({ razorpaySubscriptionId: 'sub_cx_end_1' });
    expect(sub?.status).toBe('CANCELLED');
    expect(sub?.cancelledAt).toBeInstanceOf(Date);
  });

  it('cancel_at_cycle_end=0 → user downgraded to PUBLIC immediately with tierExpiresAt=now', async () => {
    const fixedNow = new Date('2026-04-23T10:00:00Z');
    const { svc } = mkSvc({ clock: () => fixedNow });
    const user = await mkUser({ tier: 'PRO', tierExpiresAt: new Date('2026-05-23T00:00:00Z') });
    await seedSubscription(user._id, 'PRO', { razorpaySubscriptionId: 'sub_cx_now_1' });

    await svc.onCancelled({
      subscription: {
        entity: {
          id: 'sub_cx_now_1',
          notes: { cancel_at_cycle_end: 0 },
        },
      },
    });

    const after = await UserModel.findById(user._id);
    expect(after?.tier).toBe('PUBLIC');
    expect(after?.tierExpiresAt?.toISOString()).toBe(fixedNow.toISOString());
  });
});

describe('SubscriptionService webhook: pause / resume', () => {
  it('onPaused → Subscription.status=PAUSED, user tier unchanged', async () => {
    const { svc } = mkSvc();
    const user = await mkUser({ tier: 'PRO' });
    await seedSubscription(user._id, 'PRO', { razorpaySubscriptionId: 'sub_pause_1' });

    await svc.onPaused({ subscription: { entity: { id: 'sub_pause_1' } } });

    const sub = await SubscriptionModel.findOne({ razorpaySubscriptionId: 'sub_pause_1' });
    expect(sub?.status).toBe('PAUSED');
    const after = await UserModel.findById(user._id);
    expect(after?.tier).toBe('PRO');
  });

  it('onResumed → Subscription.status=ACTIVE', async () => {
    const { svc } = mkSvc();
    const user = await mkUser();
    await seedSubscription(user._id, 'PRO', { razorpaySubscriptionId: 'sub_resume_1' });
    await SubscriptionModel.updateOne(
      { razorpaySubscriptionId: 'sub_resume_1' },
      { $set: { status: 'PAUSED' } },
    );

    await svc.onResumed({ subscription: { entity: { id: 'sub_resume_1' } } });

    const sub = await SubscriptionModel.findOne({ razorpaySubscriptionId: 'sub_resume_1' });
    expect(sub?.status).toBe('ACTIVE');
  });
});
