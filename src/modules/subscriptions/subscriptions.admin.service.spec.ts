import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  clearAllCollections,
  connectTestMongo,
  disconnectTestMongo,
} from '../../../test/testing/mongo.js';
import { MODELS } from '../../shared/models/index.js';
import { SubscriptionModel } from '../../shared/models/Subscription.model.js';
import { SubscriptionPaymentModel } from '../../shared/models/SubscriptionPayment.model.js';
import { AdminSubscriptionService } from './subscriptions.admin.service.js';

type AnyModel = { syncIndexes(): Promise<string[]> };

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

describe('AdminSubscriptionService.listAll', () => {
  it('filters by tier and status, sorts newest-first', async () => {
    const svc = new AdminSubscriptionService();
    const user = new Types.ObjectId();
    await SubscriptionModel.create([
      {
        userId: user,
        tier: 'PRO',
        razorpaySubscriptionId: 's_a',
        razorpayPlanId: 'plan_PRO',
        status: 'ACTIVE',
        billingCycle: 'MONTHLY',
        paidCount: 1,
        autoRenew: true,
        createdAt: new Date('2026-04-10T00:00:00Z'),
      },
      {
        userId: user,
        tier: 'PRO_MAX',
        razorpaySubscriptionId: 's_b',
        razorpayPlanId: 'plan_PROMAX',
        status: 'ACTIVE',
        billingCycle: 'MONTHLY',
        paidCount: 1,
        autoRenew: true,
        createdAt: new Date('2026-04-20T00:00:00Z'),
      },
      {
        userId: user,
        tier: 'PRO',
        razorpaySubscriptionId: 's_c',
        razorpayPlanId: 'plan_PRO',
        status: 'HALTED',
        billingCycle: 'MONTHLY',
        paidCount: 0,
        autoRenew: true,
        createdAt: new Date('2026-04-15T00:00:00Z'),
      },
    ]);

    const activePro = await svc.listAll({ tier: 'PRO', status: 'ACTIVE' });
    expect(activePro.items).toHaveLength(1);
    expect(activePro.items[0]?.razorpaySubscriptionId).toBe('s_a');

    const allPro = await svc.listAll({ tier: 'PRO' });
    expect(allPro.items.map((s) => s.razorpaySubscriptionId)).toEqual(['s_c', 's_a']);
  });
});

describe('AdminSubscriptionService.getRevenueReport', () => {
  it('sums SubscriptionPayment.amount in the window and splits by tier (gross, no refund deduction)', async () => {
    const svc = new AdminSubscriptionService();
    const user = new Types.ObjectId();
    const subPro = await SubscriptionModel.create({
      userId: user,
      tier: 'PRO',
      razorpaySubscriptionId: 'sub_rev_pro',
      razorpayPlanId: 'plan_PRO',
      status: 'ACTIVE',
      billingCycle: 'MONTHLY',
      paidCount: 1,
      autoRenew: true,
    });
    const subProMax = await SubscriptionModel.create({
      userId: user,
      tier: 'PRO_MAX',
      razorpaySubscriptionId: 'sub_rev_promax',
      razorpayPlanId: 'plan_PROMAX',
      status: 'ACTIVE',
      billingCycle: 'MONTHLY',
      paidCount: 1,
      autoRenew: true,
    });

    const from = new Date('2026-04-01T00:00:00Z');
    const to = new Date('2026-04-30T23:59:59Z');

    await SubscriptionPaymentModel.create([
      {
        subscriptionId: subPro._id,
        userId: user,
        razorpayPaymentId: 'p1',
        amount: 5900,
        sacCode: '998439',
        status: 'CAPTURED',
        capturedAt: new Date('2026-04-10T00:00:00Z'),
      },
      {
        subscriptionId: subPro._id,
        userId: user,
        razorpayPaymentId: 'p2',
        amount: 5900,
        sacCode: '998439',
        status: 'CAPTURED',
        capturedAt: new Date('2026-04-20T00:00:00Z'),
      },
      {
        subscriptionId: subProMax._id,
        userId: user,
        razorpayPaymentId: 'p3',
        amount: 11800,
        sacCode: '998439',
        status: 'CAPTURED',
        capturedAt: new Date('2026-04-15T00:00:00Z'),
      },
      // Out of window — excluded.
      {
        subscriptionId: subPro._id,
        userId: user,
        razorpayPaymentId: 'p4_out',
        amount: 5900,
        sacCode: '998439',
        status: 'CAPTURED',
        capturedAt: new Date('2026-03-20T00:00:00Z'),
      },
    ]);

    const report = await svc.getRevenueReport(from, to);
    expect(report.count).toBe(3);
    expect(report.byTier.PRO).toBe(11800);
    expect(report.byTier.PRO_MAX).toBe(11800);
    expect(report.totalPaise).toBe(23600);
  });
});
