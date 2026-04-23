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
import { AuditLogModel } from '../../shared/models/AuditLog.model.js';
import { DonationModel } from '../../shared/models/Donation.model.js';
import { MODELS } from '../../shared/models/index.js';

type AnyModel = { syncIndexes(): Promise<string[]> };

async function seedDonation(): Promise<Types.ObjectId> {
  const doc = await DonationModel.create({
    userId: new Types.ObjectId(),
    amount: 10000,
    razorpayOrderId: `order_${new Types.ObjectId().toHexString()}`,
    status: 'CAPTURED',
  });
  return doc._id;
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

describe('admin-donations routes', () => {
  const app = createApp();

  it('GET / returns the list envelope for SUPPORT_ADMIN', async () => {
    await seedDonation();
    await seedDonation();
    const seed = await seedAdminSession({ role: 'SUPPORT_ADMIN' });

    const res = await request(app).get('/api/v1/admin/donations').set('Cookie', seed.cookieHeader);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data.items)).toBe(true);
    expect(res.body.data.items.length).toBe(2);
  });

  it('rejects with 401 without session, 403 when SUPPORT_ADMIN tries to feature', async () => {
    const donationId = await seedDonation();

    const noSession = await request(app).post(`/api/v1/admin/donations/${donationId}/feature`);
    expect(noSession.status).toBe(401);
    expect(noSession.body.error.code).toBe('UNAUTHORIZED');

    const support = await seedAdminSession({ role: 'SUPPORT_ADMIN' });
    const wrongRole = await request(app)
      .post(`/api/v1/admin/donations/${donationId}/feature`)
      .set('Cookie', support.cookieHeader)
      .set(support.csrfHeaderName, support.csrfToken);
    expect(wrongRole.status).toBe(403);
    expect(wrongRole.body.error.code).toBe('FORBIDDEN');
  });

  it('POST /:id/feature records audit with DONATION_FEATURE action + before/after snapshots', async () => {
    const donationId = await seedDonation();
    const seed = await seedAdminSession({ role: 'PAYMENT_ADMIN' });

    const res = await request(app)
      .post(`/api/v1/admin/donations/${donationId}/feature`)
      .set('Cookie', seed.cookieHeader)
      .set(seed.csrfHeaderName, seed.csrfToken);

    expect(res.status).toBe(200);

    const audit = await AuditLogModel.findOne({ action: 'DONATION_FEATURE' });
    expect(audit).toBeTruthy();
    expect(audit?.actorId.toHexString()).toBe(seed.adminId);
    expect(audit?.resource?.kind).toBe('Donation');
    expect(audit?.resource?.id?.toHexString()).toBe(donationId.toHexString());
    expect(audit?.after).toBeTruthy();
  });
});
