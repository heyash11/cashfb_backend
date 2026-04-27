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

describe('SubscriptionService webhook: subscription.charged (Phase 11.3)', () => {
  it('creates SubscriptionPayment, increments paidCount, pushes subscriptions[] entry, derives tier, enqueues invoice', async () => {
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
    expect(payment?.invoiceNumber).toBeUndefined();
    expect(payment?.invoicePdfUrl).toBeUndefined();

    const afterSub = await SubscriptionModel.findById(sub._id);
    expect(afterSub?.paidCount).toBe(2);
    expect(afterSub?.status).toBe('ACTIVE');

    const afterUser = await UserModel.findById(user._id);
    // Phase 11.3: subscriptions[] entry pushed.
    expect(afterUser?.subscriptions).toHaveLength(1);
    expect(afterUser?.subscriptions[0]).toMatchObject({
      tier: 'PRO',
      status: 'ACTIVE',
    });
    expect(String(afterUser?.subscriptions[0]?.subscriptionId)).toBe(String(sub._id));
    expect(afterUser?.subscriptions[0]?.expiresAt?.toISOString()).toBe(
      new Date(currentEndSec * 1000).toISOString(),
    );
    // Legacy denormalized fields kept in sync via derivation.
    expect(afterUser?.tier).toBe('PRO');
    expect(afterUser?.tierExpiresAt?.toISOString()).toBe(
      new Date(currentEndSec * 1000).toISOString(),
    );

    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    const [arg] = enqueueSpy.mock.calls[0] ?? [];
    expect(arg).toEqual({ paymentId: String(payment?._id) });
  });

  it('rolls back cleanly when user update fails mid-transaction (no payment row, no paidCount bump, subscriptions[] unchanged)', async () => {
    const { svc, enqueueSpy } = mkSvc();
    const user = await mkUser({ tier: 'PUBLIC' });
    const sub = await seedSubscription(user._id, 'PRO', {
      razorpaySubscriptionId: 'sub_rb_1',
    });

    // Phase 11.3: User update is now a pipeline call on UserModel
    // directly (not via UserRepository), so the spy targets the
    // mongoose method.
    const spy = vi
      .spyOn(UserModel, 'updateOne')
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

    expect(await SubscriptionPaymentModel.countDocuments({ razorpayPaymentId: 'pay_rb_1' })).toBe(
      0,
    );

    const subAfter = await SubscriptionModel.findById(sub._id);
    expect(subAfter?.paidCount).toBe(1);
    expect(subAfter?.status).toBe('ACTIVE');

    const userAfter = await UserModel.findById(user._id);
    expect(userAfter?.tier).toBe('PUBLIC');
    expect(userAfter?.subscriptions ?? []).toEqual([]);

    expect(enqueueSpy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  // Phase 11.3 — stacking + replacement + race specs

  it('stackable activation: PRO already active, onCharged for PRO_MAX → 2 entries, derived tier PRO_MAX', async () => {
    const { svc } = mkSvc();
    const user = await mkUser({ tier: 'PRO' });
    const proSub = await seedSubscription(user._id, 'PRO', {
      razorpaySubscriptionId: 'sub_stack_pro',
    });
    const proExpiresAt = new Date('2026-05-23T00:00:00Z');
    // Pre-populate PRO entry to simulate prior charged event.
    await UserModel.updateOne(
      { _id: user._id },
      {
        $set: {
          subscriptions: [
            {
              tier: 'PRO',
              status: 'ACTIVE',
              expiresAt: proExpiresAt,
              subscriptionId: proSub._id,
            },
          ],
          tierExpiresAt: proExpiresAt,
        },
      },
    );
    const proMaxSub = await seedSubscription(user._id, 'PRO_MAX', {
      razorpaySubscriptionId: 'sub_stack_pmax',
    });
    const proMaxEndSec = Math.floor(new Date('2026-06-30T00:00:00Z').getTime() / 1000);

    await svc.onCharged({
      subscription: {
        entity: { id: 'sub_stack_pmax', status: 'active', current_end: proMaxEndSec },
      },
      payment: { entity: { id: 'pay_stack_pmax', amount: 11800, status: 'captured' } },
    });

    const after = await UserModel.findById(user._id);
    expect(after?.subscriptions).toHaveLength(2);
    const tiers = after?.subscriptions.map((s) => s.tier).sort();
    expect(tiers).toEqual(['PRO', 'PRO_MAX']);
    // Derivation: PRO_MAX wins, expiresAt = PRO_MAX expiry.
    expect(after?.tier).toBe('PRO_MAX');
    expect(after?.tierExpiresAt?.toISOString()).toBe(new Date(proMaxEndSec * 1000).toISOString());
    // Confirm subscriptionId on PRO_MAX entry:
    const proMaxEntry = after?.subscriptions.find((s) => s.tier === 'PRO_MAX');
    expect(String(proMaxEntry?.subscriptionId)).toBe(String(proMaxSub._id));
  });

  it('replacement-by-tier: re-subscribe PRO with different subId → entry replaced (not duplicated)', async () => {
    const { svc } = mkSvc();
    const user = await mkUser({ tier: 'PRO' });
    const oldSub = await seedSubscription(user._id, 'PRO', {
      razorpaySubscriptionId: 'sub_old_pro',
    });
    await UserModel.updateOne(
      { _id: user._id },
      {
        $set: {
          subscriptions: [
            {
              tier: 'PRO',
              status: 'CANCELLED',
              expiresAt: new Date('2026-04-30T00:00:00Z'),
              subscriptionId: oldSub._id,
            },
          ],
        },
      },
    );

    const newSub = await seedSubscription(user._id, 'PRO', {
      razorpaySubscriptionId: 'sub_new_pro',
    });
    const newEndSec = Math.floor(new Date('2026-06-30T00:00:00Z').getTime() / 1000);

    await svc.onCharged({
      subscription: { entity: { id: 'sub_new_pro', status: 'active', current_end: newEndSec } },
      payment: { entity: { id: 'pay_new_pro', amount: 5900, status: 'captured' } },
    });

    const after = await UserModel.findById(user._id);
    // Still ONE PRO entry, not two.
    expect(after?.subscriptions).toHaveLength(1);
    expect(after?.subscriptions[0]?.tier).toBe('PRO');
    expect(after?.subscriptions[0]?.status).toBe('ACTIVE');
    // The new subId replaced the old.
    expect(String(after?.subscriptions[0]?.subscriptionId)).toBe(String(newSub._id));
    expect(String(after?.subscriptions[0]?.subscriptionId)).not.toBe(String(oldSub._id));
  });

  it('idempotent replay: same charged event delivered twice → single payment row, single entry', async () => {
    const { svc, enqueueSpy } = mkSvc();
    const user = await mkUser({ tier: 'PUBLIC' });
    await seedSubscription(user._id, 'PRO', { razorpaySubscriptionId: 'sub_idem_1' });

    const payload = {
      subscription: {
        entity: {
          id: 'sub_idem_1',
          status: 'active',
          current_end: Math.floor(new Date('2026-05-23T00:00:00Z').getTime() / 1000),
        },
      },
      payment: { entity: { id: 'pay_idem_1', amount: 5900, status: 'captured' } },
    };

    await svc.onCharged(payload);
    await svc.onCharged(payload);

    expect(await SubscriptionPaymentModel.countDocuments({ razorpayPaymentId: 'pay_idem_1' })).toBe(
      1,
    );
    const after = await UserModel.findById(user._id);
    expect(after?.subscriptions).toHaveLength(1);
    expect(after?.tier).toBe('PRO');
    // First call enqueued; the second is a no-op (upsert match path
    // returns null pre-enqueue).
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
  });
});

describe('SubscriptionService webhook: subscription.halted (Phase 11.3)', () => {
  it('marks the matching tier-entry CANCELLED + expiresAt=now; other tiers untouched; derivation downgrades', async () => {
    const fixedNow = new Date('2026-04-23T10:00:00Z');
    const { svc } = mkSvc({ clock: () => fixedNow });
    const user = await mkUser({ tier: 'PRO_MAX', tierExpiresAt: new Date('2026-06-30T00:00:00Z') });
    const proSub = await seedSubscription(user._id, 'PRO', {
      razorpaySubscriptionId: 'sub_halt_pro',
    });
    const proMaxSub = await seedSubscription(user._id, 'PRO_MAX', {
      razorpaySubscriptionId: 'sub_halt_pmax',
    });
    // Both entries seeded as ACTIVE.
    await UserModel.updateOne(
      { _id: user._id },
      {
        $set: {
          subscriptions: [
            {
              tier: 'PRO',
              status: 'ACTIVE',
              expiresAt: new Date('2026-05-23T00:00:00Z'),
              subscriptionId: proSub._id,
            },
            {
              tier: 'PRO_MAX',
              status: 'ACTIVE',
              expiresAt: new Date('2026-06-30T00:00:00Z'),
              subscriptionId: proMaxSub._id,
            },
          ],
        },
      },
    );

    await svc.onHalted({ subscription: { entity: { id: 'sub_halt_pro' } } });

    const after = await UserModel.findById(user._id);
    const proEntry = after?.subscriptions.find((s) => s.tier === 'PRO');
    const proMaxEntry = after?.subscriptions.find((s) => s.tier === 'PRO_MAX');
    expect(proEntry?.status).toBe('CANCELLED');
    expect(proEntry?.expiresAt?.toISOString()).toBe(fixedNow.toISOString());
    // PRO_MAX entry must be entirely untouched.
    expect(proMaxEntry?.status).toBe('ACTIVE');
    expect(proMaxEntry?.expiresAt?.toISOString()).toBe('2026-06-30T00:00:00.000Z');
    // Derivation: PRO_MAX still wins (PRO is now CANCELLED-expired).
    expect(after?.tier).toBe('PRO_MAX');
    expect(after?.tierExpiresAt?.toISOString()).toBe('2026-06-30T00:00:00.000Z');
  });

  it('only-tier user halted → derivation drops to PUBLIC, tierExpiresAt=null', async () => {
    const fixedNow = new Date('2026-04-23T10:00:00Z');
    const { svc } = mkSvc({ clock: () => fixedNow });
    const user = await mkUser({ tier: 'PRO' });
    const proSub = await seedSubscription(user._id, 'PRO', {
      razorpaySubscriptionId: 'sub_halt_solo',
    });
    await UserModel.updateOne(
      { _id: user._id },
      {
        $set: {
          subscriptions: [
            {
              tier: 'PRO',
              status: 'ACTIVE',
              expiresAt: new Date('2026-05-23T00:00:00Z'),
              subscriptionId: proSub._id,
            },
          ],
        },
      },
    );

    await svc.onHalted({ subscription: { entity: { id: 'sub_halt_solo' } } });

    const after = await UserModel.findById(user._id);
    expect(after?.tier).toBe('PUBLIC');
    expect(after?.tierExpiresAt ?? null).toBeNull();
    // Entry stays in array (CANCELLED + expiresAt=now). Sweep removes
    // it on next pass; derivation already excludes it.
    expect(after?.subscriptions).toHaveLength(1);
    expect(after?.subscriptions[0]?.status).toBe('CANCELLED');
    expect(after?.subscriptions[0]?.expiresAt?.toISOString()).toBe(fixedNow.toISOString());
  });
});

describe('SubscriptionService webhook: subscription.cancelled (Phase 11.3)', () => {
  it('cancel_at_cycle_end=1 → entry status=CANCELLED, expiresAt unchanged (grace), derivation still PRO', async () => {
    const { svc } = mkSvc();
    const originalExpiry = new Date('2026-05-23T00:00:00Z');
    const user = await mkUser({ tier: 'PRO', tierExpiresAt: originalExpiry });
    const sub = await seedSubscription(user._id, 'PRO', {
      razorpaySubscriptionId: 'sub_cx_end_1',
    });
    await UserModel.updateOne(
      { _id: user._id },
      {
        $set: {
          subscriptions: [
            {
              tier: 'PRO',
              status: 'ACTIVE',
              expiresAt: originalExpiry,
              subscriptionId: sub._id,
            },
          ],
        },
      },
    );

    await svc.onCancelled({
      subscription: { entity: { id: 'sub_cx_end_1', notes: { cancel_at_cycle_end: 1 } } },
    });

    const after = await UserModel.findById(user._id);
    expect(after?.subscriptions).toHaveLength(1);
    expect(after?.subscriptions[0]?.status).toBe('CANCELLED');
    expect(after?.subscriptions[0]?.expiresAt?.toISOString()).toBe(originalExpiry.toISOString());
    // CANCELLED + future expiresAt → still PRO via grace.
    expect(after?.tier).toBe('PRO');
    expect(after?.tierExpiresAt?.toISOString()).toBe(originalExpiry.toISOString());

    const subAfter = await SubscriptionModel.findOne({ razorpaySubscriptionId: 'sub_cx_end_1' });
    expect(subAfter?.status).toBe('CANCELLED');
    expect(subAfter?.cancelledAt).toBeInstanceOf(Date);
  });

  it('cancel_at_cycle_end=0 → entry CANCELLED + expiresAt=now, derivation drops to PUBLIC', async () => {
    const fixedNow = new Date('2026-04-23T10:00:00Z');
    const { svc } = mkSvc({ clock: () => fixedNow });
    const user = await mkUser({ tier: 'PRO', tierExpiresAt: new Date('2026-05-23T00:00:00Z') });
    const sub = await seedSubscription(user._id, 'PRO', {
      razorpaySubscriptionId: 'sub_cx_now_1',
    });
    await UserModel.updateOne(
      { _id: user._id },
      {
        $set: {
          subscriptions: [
            {
              tier: 'PRO',
              status: 'ACTIVE',
              expiresAt: new Date('2026-05-23T00:00:00Z'),
              subscriptionId: sub._id,
            },
          ],
        },
      },
    );

    await svc.onCancelled({
      subscription: { entity: { id: 'sub_cx_now_1', notes: { cancel_at_cycle_end: 0 } } },
    });

    const after = await UserModel.findById(user._id);
    expect(after?.subscriptions[0]?.status).toBe('CANCELLED');
    expect(after?.subscriptions[0]?.expiresAt?.toISOString()).toBe(fixedNow.toISOString());
    // Derivation: CANCELLED + expiresAt == now → not active (rule:
    // CANCELLED counts only if expiresAt > now). So PUBLIC.
    expect(after?.tier).toBe('PUBLIC');
    expect(after?.tierExpiresAt ?? null).toBeNull();
  });

  // Phase 11.3 R2 — late cancellation for replaced subId is a no-op.
  it('R2 race: late cancellation for an old subId after replacement → no-op (newer entry survives)', async () => {
    const { svc } = mkSvc();
    const user = await mkUser({ tier: 'PRO' });
    const oldSub = await seedSubscription(user._id, 'PRO', {
      razorpaySubscriptionId: 'sub_old',
    });
    const newSub = await seedSubscription(user._id, 'PRO', {
      razorpaySubscriptionId: 'sub_new',
    });
    // Subscriptions[] currently holds the NEW subId (post-replacement).
    await UserModel.updateOne(
      { _id: user._id },
      {
        $set: {
          subscriptions: [
            {
              tier: 'PRO',
              status: 'ACTIVE',
              expiresAt: new Date('2027-01-01T00:00:00Z'),
              subscriptionId: newSub._id,
            },
          ],
        },
      },
    );

    // Late cancellation arrives for the OLD subscription.
    await svc.onCancelled({
      subscription: { entity: { id: 'sub_old', notes: { cancel_at_cycle_end: 1 } } },
    });

    const after = await UserModel.findById(user._id);
    // The NEW subscription's entry must be UNTOUCHED.
    expect(after?.subscriptions).toHaveLength(1);
    expect(after?.subscriptions[0]?.status).toBe('ACTIVE');
    expect(String(after?.subscriptions[0]?.subscriptionId)).toBe(String(newSub._id));
    // Subscription doc for old subId IS marked CANCELLED (it's still
    // a real Subscription row; only the User's array entry is
    // protected from late cancellation).
    const oldAfter = await SubscriptionModel.findById(oldSub._id);
    expect(oldAfter?.status).toBe('CANCELLED');
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
