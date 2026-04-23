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
import { NotificationModel } from '../../shared/models/Notification.model.js';
import { MODELS } from '../../shared/models/index.js';
import { UserModel, type UserAttrs } from '../../shared/models/User.model.js';

type AnyModel = { syncIndexes(): Promise<string[]> };

async function seedUser(tier: UserAttrs['tier'] = 'PUBLIC') {
  return UserModel.create({
    phone: `9${Math.floor(100000000 + Math.random() * 899999999)}`,
    dob: new Date('1998-01-01'),
    declaredState: 'IN-MH',
    tier,
    coinBalance: 0,
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

describe('admin-notifications routes', () => {
  const app = createApp();

  it('POST /broadcast tier=PRO inserts one notification per PRO user with shared broadcastId', async () => {
    await seedUser('PUBLIC');
    const pro1 = await seedUser('PRO');
    const pro2 = await seedUser('PRO');
    const seed = await seedAdminSession({ role: 'CONTENT_ADMIN' });

    const res = await request(app)
      .post('/api/v1/admin/notifications/broadcast')
      .set('Cookie', seed.cookieHeader)
      .set(seed.csrfHeaderName, seed.csrfToken)
      .send({
        target: { mode: 'tier', tier: 'PRO' },
        title: 'Exclusive PRO promo',
        body: 'New PRO perks landing this week.',
      });

    expect(res.status).toBe(200);
    expect(res.body.data.inserted).toBe(2);
    const broadcastId = res.body.data.broadcastId as string;
    expect(broadcastId).toBeTruthy();

    const notifications = await NotificationModel.find({ type: 'CUSTOM' });
    expect(notifications.length).toBe(2);
    // Fan-out reached exactly the PRO users, not the PUBLIC user.
    const targetedIds = notifications.map((n) => String(n.userId)).sort();
    expect(targetedIds).toEqual([String(pro1._id), String(pro2._id)].sort());
    // Shared broadcastId applied consistently across every inserted row.
    expect(
      notifications.every(
        (n) => (n.payload as { broadcastId?: string } | undefined)?.broadcastId === broadcastId,
      ),
    ).toBe(true);

    const audit = await AuditLogModel.findOne({ action: 'NOTIFICATION_BROADCAST' });
    expect(audit).toBeTruthy();
    expect((audit?.after as { broadcastId?: string; inserted?: number } | null)?.inserted).toBe(2);
  });

  it('POST /broadcast user=<id> inserts exactly one row targeted at that user', async () => {
    const target = await seedUser('PRO_MAX');
    await seedUser('PRO_MAX');
    const seed = await seedAdminSession({ role: 'CONTENT_ADMIN' });

    const res = await request(app)
      .post('/api/v1/admin/notifications/broadcast')
      .set('Cookie', seed.cookieHeader)
      .set(seed.csrfHeaderName, seed.csrfToken)
      .send({
        target: { mode: 'user', userId: target._id.toString() },
        title: 'Direct ping',
      });

    expect(res.status).toBe(200);
    expect(res.body.data.inserted).toBe(1);

    const rows = await NotificationModel.find({});
    expect(rows.length).toBe(1);
    expect(String(rows[0]?.userId)).toBe(String(target._id));
  });

  it('rejects 401 without session, 403 for SUPPORT_ADMIN, and empty-body ValidationError', async () => {
    const noSession = await request(app)
      .post('/api/v1/admin/notifications/broadcast')
      .send({ target: { mode: 'all' } });
    expect(noSession.status).toBe(401);

    const support = await seedAdminSession({ role: 'SUPPORT_ADMIN' });
    const wrongRole = await request(app)
      .post('/api/v1/admin/notifications/broadcast')
      .set('Cookie', support.cookieHeader)
      .set(support.csrfHeaderName, support.csrfToken)
      .send({ target: { mode: 'all' }, title: 'hi' });
    expect(wrongRole.status).toBe(403);

    // Missing title AND body → 400 VALIDATION_FAILED (refinement).
    const content = await seedAdminSession({ role: 'CONTENT_ADMIN' });
    const empty = await request(app)
      .post('/api/v1/admin/notifications/broadcast')
      .set('Cookie', content.cookieHeader)
      .set(content.csrfHeaderName, content.csrfToken)
      .send({ target: { mode: 'all' } });
    expect(empty.status).toBe(400);
    expect(empty.body.error.code).toBe('VALIDATION_FAILED');

    // Unknown user → 400 ValidationError (service layer).
    const badUser = await request(app)
      .post('/api/v1/admin/notifications/broadcast')
      .set('Cookie', content.cookieHeader)
      .set(content.csrfHeaderName, content.csrfToken)
      .send({
        target: { mode: 'user', userId: new Types.ObjectId().toHexString() },
        title: 'hi',
      });
    expect(badUser.status).toBe(400);
  });
});
