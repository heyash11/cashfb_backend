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
import { redis } from '../../config/redis.js';
import { AuditLogModel } from '../../shared/models/AuditLog.model.js';
import { CoinTransactionModel } from '../../shared/models/CoinTransaction.model.js';
import { MODELS } from '../../shared/models/index.js';
import { UserModel } from '../../shared/models/User.model.js';

type AnyModel = { syncIndexes(): Promise<string[]> };

async function seedUser(overrides: Partial<Parameters<typeof UserModel.create>[0]> = {}) {
  return UserModel.create({
    phone: `9${Math.floor(100000000 + Math.random() * 899999999)}`,
    dob: new Date('1998-01-01'),
    declaredState: 'IN-MH',
    coinBalance: 10,
    ...overrides,
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

describe('admin-users routes', () => {
  const app = createApp();

  it('GET / returns filtered list for SUPPORT_ADMIN (search by phone prefix)', async () => {
    await seedUser({ phone: '9111111111' });
    await seedUser({ phone: '9222222222' });
    const seed = await seedAdminSession({ role: 'SUPPORT_ADMIN' });

    const res = await request(app)
      .get('/api/v1/admin/users?search=9111')
      .set('Cookie', seed.cookieHeader);

    expect(res.status).toBe(200);
    expect(res.body.data.items.length).toBe(1);
    expect(res.body.data.items[0].phone).toBe('9111111111');
  });

  it('POST /:id/block sets the blocked subdoc and records audit row with actor', async () => {
    const user = await seedUser();
    const seed = await seedAdminSession({ role: 'SUPPORT_ADMIN' });

    const res = await request(app)
      .post(`/api/v1/admin/users/${user._id}/block`)
      .set('Cookie', seed.cookieHeader)
      .set(seed.csrfHeaderName, seed.csrfToken)
      .send({ reason: 'fraud investigation opened by support' });

    expect(res.status).toBe(200);

    const row = await UserModel.findById(user._id);
    expect(row?.blocked.isBlocked).toBe(true);
    expect(row?.blocked.reason).toBe('fraud investigation opened by support');
    expect(row?.blocked.by?.toString()).toBe(seed.adminId);

    const audit = await AuditLogModel.findOne({ action: 'USER_BLOCK' });
    expect(audit).toBeTruthy();
    expect(audit?.actorId.toHexString()).toBe(seed.adminId);
    expect(audit?.resource?.kind).toBe('User');
    expect(
      (audit?.before as { blocked?: { isBlocked?: boolean } } | null)?.blocked?.isBlocked,
    ).toBe(false);
    expect((audit?.after as { blocked?: { isBlocked?: boolean } } | null)?.blocked?.isBlocked).toBe(
      true,
    );
  });

  it('POST /:id/coins credits atomically + inserts CoinTransaction with reason + audit delta', async () => {
    const user = await seedUser({ coinBalance: 10 });
    const seed = await seedAdminSession({ role: 'PAYMENT_ADMIN' });

    const res = await request(app)
      .post(`/api/v1/admin/users/${user._id}/coins`)
      .set('Cookie', seed.cookieHeader)
      .set(seed.csrfHeaderName, seed.csrfToken)
      .send({ delta: 25, reason: 'manual credit — goodwill compensation #4821' });

    expect(res.status).toBe(200);

    const after = await UserModel.findById(user._id);
    expect(after?.coinBalance).toBe(35);

    const txs = await CoinTransactionModel.find({ userId: user._id });
    expect(txs.length).toBe(1);
    expect(txs[0]?.type).toBe('ADMIN_CREDIT');
    expect(txs[0]?.amount).toBe(25);
    expect(txs[0]?.balanceAfter).toBe(35);
    expect(txs[0]?.reason).toBe('manual credit — goodwill compensation #4821');
    expect(txs[0]?.reference?.kind).toBe('Admin');
    expect(txs[0]?.reference?.id?.toString()).toBe(seed.adminId);

    const audit = await AuditLogModel.findOne({ action: 'USER_COINS_ADJUST' });
    expect(audit).toBeTruthy();
    expect((audit?.before as { coinBalance?: number } | null)?.coinBalance).toBe(10);
    expect((audit?.after as { coinBalance?: number; delta?: number } | null)?.coinBalance).toBe(35);
    expect((audit?.after as { delta?: number } | null)?.delta).toBe(25);
  });

  it('POST /:id/force-logout writes Redis cutoff (SUPER_ADMIN only)', async () => {
    const user = await seedUser();
    const seed = await seedAdminSession({ role: 'SUPER_ADMIN' });

    const res = await request(app)
      .post(`/api/v1/admin/users/${user._id}/force-logout`)
      .set('Cookie', seed.cookieHeader)
      .set(seed.csrfHeaderName, seed.csrfToken)
      .send({ reason: 'suspicious session activity reported' });

    expect(res.status).toBe(200);

    const stored = await redis.get(`auth:force-logout:${user._id}`);
    expect(stored).toBeTruthy();
    const cutoff = Number.parseInt(stored!, 10);
    const nowSec = Math.floor(Date.now() / 1000);
    expect(cutoff).toBeGreaterThanOrEqual(nowSec - 5);
    expect(cutoff).toBeLessThanOrEqual(nowSec + 5);

    // Cleanup so sibling specs' Redis state stays tidy (scoped to
    // this specific userId; safe for parallel workers).
    await redis.del(`auth:force-logout:${user._id}`);
  });

  it('rejects PAYMENT_ADMIN attempting block (SUPPORT/SUPER only) and SUPPORT attempting coin-adjust', async () => {
    const user = await seedUser();

    const payment = await seedAdminSession({ role: 'PAYMENT_ADMIN' });
    const wrongBlock = await request(app)
      .post(`/api/v1/admin/users/${user._id}/block`)
      .set('Cookie', payment.cookieHeader)
      .set(payment.csrfHeaderName, payment.csrfToken)
      .send({ reason: 'payment admin trying to block a user' });
    expect(wrongBlock.status).toBe(403);

    const support = await seedAdminSession({ role: 'SUPPORT_ADMIN' });
    const wrongCoins = await request(app)
      .post(`/api/v1/admin/users/${user._id}/coins`)
      .set('Cookie', support.cookieHeader)
      .set(support.csrfHeaderName, support.csrfToken)
      .send({ delta: 10, reason: 'support admin trying to adjust coins' });
    expect(wrongCoins.status).toBe(403);
  });
});

// Prevent the "seedUser used before declare" TS hoisting warning.
void new Types.ObjectId();
