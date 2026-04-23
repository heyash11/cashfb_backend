import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import request from 'supertest';
import { createApp } from '../../app.js';
import {
  clearAllCollections,
  connectTestMongo,
  disconnectTestMongo,
} from '../../../test/testing/mongo.js';
import { seedAdminSession } from '../../../test/testing/admin-session-seed.js';
import { MODELS } from '../../shared/models/index.js';
import { SubscriptionModel } from '../../shared/models/Subscription.model.js';
import { SubscriptionPaymentModel } from '../../shared/models/SubscriptionPayment.model.js';

type AnyModel = { syncIndexes(): Promise<string[]> };

async function seedSubscriptionWithPayment(tier: 'PRO' | 'PRO_MAX'): Promise<Types.ObjectId> {
  const sub = await SubscriptionModel.create({
    userId: new Types.ObjectId(),
    tier,
    razorpaySubscriptionId: `sub_${new Types.ObjectId().toHexString()}`,
    razorpayPlanId: `plan_${tier}`,
    status: 'ACTIVE',
    billingCycle: 'MONTHLY',
    paidCount: 1,
    autoRenew: true,
  });
  await SubscriptionPaymentModel.create({
    subscriptionId: sub._id,
    userId: sub.userId,
    razorpayPaymentId: `pay_${new Types.ObjectId().toHexString()}`,
    amount: tier === 'PRO' ? 5900 : 11800,
    status: 'CAPTURED',
    capturedAt: new Date('2026-04-15T10:00:00.000Z'),
  });
  return sub._id;
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

describe('admin-subscriptions routes', () => {
  const app = createApp();

  it('GET / returns list envelope for SUPPORT_ADMIN', async () => {
    await seedSubscriptionWithPayment('PRO');
    await seedSubscriptionWithPayment('PRO_MAX');
    const seed = await seedAdminSession({ role: 'SUPPORT_ADMIN' });

    const res = await request(app)
      .get('/api/v1/admin/subscriptions')
      .set('Cookie', seed.cookieHeader);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.items)).toBe(true);
    expect(res.body.data.items.length).toBe(2);
  });

  it('rejects 401 without session, 403 when SUPPORT_ADMIN hits /revenue', async () => {
    const noSession = await request(app).get('/api/v1/admin/subscriptions/revenue');
    expect(noSession.status).toBe(401);

    const support = await seedAdminSession({ role: 'SUPPORT_ADMIN' });
    const wrongRole = await request(app)
      .get('/api/v1/admin/subscriptions/revenue?from=2026-04-01&to=2026-04-30')
      .set('Cookie', support.cookieHeader);
    expect(wrongRole.status).toBe(403);
  });

  it('GET /revenue returns tier-grouped totals for PAYMENT_ADMIN', async () => {
    await seedSubscriptionWithPayment('PRO');
    await seedSubscriptionWithPayment('PRO');
    await seedSubscriptionWithPayment('PRO_MAX');
    const seed = await seedAdminSession({ role: 'PAYMENT_ADMIN' });

    const res = await request(app)
      .get('/api/v1/admin/subscriptions/revenue?from=2026-04-01&to=2026-04-30')
      .set('Cookie', seed.cookieHeader);

    expect(res.status).toBe(200);
    expect(res.body.data.count).toBe(3);
    expect(res.body.data.totalPaise).toBe(5900 + 5900 + 11800);
    expect(res.body.data.byTier.PRO).toBe(5900 + 5900);
    expect(res.body.data.byTier.PRO_MAX).toBe(11800);
  });
});
