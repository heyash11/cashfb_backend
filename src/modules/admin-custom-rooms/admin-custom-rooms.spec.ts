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
import { CustomRoomModel } from '../../shared/models/CustomRoom.model.js';
import { MODELS } from '../../shared/models/index.js';
import { PrizePoolWinnerModel } from '../../shared/models/PrizePoolWinner.model.js';

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

describe('admin-custom-rooms routes', () => {
  const app = createApp();

  it('POST / creates a room in SCHEDULED status and records audit', async () => {
    const seed = await seedAdminSession({ role: 'CONTENT_ADMIN' });
    const body = {
      game: 'BGMI',
      dayKey: '2026-04-23',
      scheduledAt: '2026-04-23T15:00:00.000Z',
      tierRequired: 'PUBLIC',
    };

    const res = await request(app)
      .post('/api/v1/admin/custom-rooms')
      .set('Cookie', seed.cookieHeader)
      .set(seed.csrfHeaderName, seed.csrfToken)
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('SCHEDULED');
    expect(res.body.data.game).toBe('BGMI');

    const audit = await AuditLogModel.findOne({ action: 'CUSTOM_ROOM_CREATE' });
    expect(audit).toBeTruthy();
    expect(audit?.actorId.toHexString()).toBe(seed.adminId);
    expect(audit?.resource?.kind).toBe('CustomRoom');
  });

  it('rejects 401 without session and 403 for SUPPORT_ADMIN on writes', async () => {
    const support = await seedAdminSession({ role: 'SUPPORT_ADMIN' });

    const noSession = await request(app).post('/api/v1/admin/custom-rooms').send({});
    expect(noSession.status).toBe(401);

    const wrongRole = await request(app)
      .post('/api/v1/admin/custom-rooms')
      .set('Cookie', support.cookieHeader)
      .set(support.csrfHeaderName, support.csrfToken)
      .send({
        game: 'BGMI',
        dayKey: '2026-04-23',
        scheduledAt: '2026-04-23T15:00:00.000Z',
      });
    expect(wrongRole.status).toBe(403);

    const listAllowed = await request(app)
      .get('/api/v1/admin/custom-rooms')
      .set('Cookie', support.cookieHeader);
    expect(listAllowed.status).toBe(200);
  });

  it('POST /:id/start flips SCHEDULED → LIVE and captures before/after in audit', async () => {
    const seed = await seedAdminSession({ role: 'CONTENT_ADMIN' });
    const room = await CustomRoomModel.create({
      game: 'BGMI',
      dayKey: '2026-04-23',
      scheduledAt: new Date('2026-04-23T15:00:00.000Z'),
      status: 'SCHEDULED',
      tierRequired: 'PUBLIC',
      participantCount: 0,
      registeredParticipants: [],
      createdBy: new Types.ObjectId(seed.adminId),
      visibleFromAt: new Date('2026-04-23T14:55:00.000Z'),
      resultEnabledAt: new Date('2026-04-23T15:30:00.000Z'),
    });

    const res = await request(app)
      .post(`/api/v1/admin/custom-rooms/${room._id}/start`)
      .set('Cookie', seed.cookieHeader)
      .set(seed.csrfHeaderName, seed.csrfToken);

    expect(res.status).toBe(200);

    const reloaded = await CustomRoomModel.findById(room._id);
    expect(reloaded?.status).toBe('LIVE');

    const audit = await AuditLogModel.findOne({ action: 'CUSTOM_ROOM_START' });
    expect(audit).toBeTruthy();
    expect((audit?.before as { status?: string } | null)?.status).toBe('SCHEDULED');
    expect((audit?.after as { status?: string } | null)?.status).toBe('LIVE');
  });

  it('POST /:id/winners rejects CONTENT_ADMIN (payment role only), accepts PAYMENT_ADMIN', async () => {
    const contentAdmin = await seedAdminSession({ role: 'CONTENT_ADMIN' });
    const paymentAdmin = await seedAdminSession({ role: 'PAYMENT_ADMIN' });
    const room = await CustomRoomModel.create({
      game: 'BGMI',
      dayKey: '2026-04-23',
      scheduledAt: new Date('2026-04-23T15:00:00.000Z'),
      status: 'COMPLETED',
      tierRequired: 'PUBLIC',
      participantCount: 0,
      registeredParticipants: [],
      createdBy: new Types.ObjectId(contentAdmin.adminId),
      visibleFromAt: new Date('2026-04-23T14:55:00.000Z'),
      resultEnabledAt: new Date('2026-04-23T15:30:00.000Z'),
    });

    const body = {
      dayKey: '2026-04-23',
      winners: [
        {
          userId: new Types.ObjectId().toHexString(),
          type: 'CUSTOM_ROOM',
          baseAmount: 100,
          tier: 'PRO',
          customRoomId: room._id.toHexString(),
        },
      ],
    };

    const rejected = await request(app)
      .post(`/api/v1/admin/custom-rooms/${room._id}/winners`)
      .set('Cookie', contentAdmin.cookieHeader)
      .set(contentAdmin.csrfHeaderName, contentAdmin.csrfToken)
      .send(body);
    expect(rejected.status).toBe(403);

    const accepted = await request(app)
      .post(`/api/v1/admin/custom-rooms/${room._id}/winners`)
      .set('Cookie', paymentAdmin.cookieHeader)
      .set(paymentAdmin.csrfHeaderName, paymentAdmin.csrfToken)
      .send(body);
    expect(accepted.status).toBe(200);
    expect(accepted.body.data.assigned).toBe(1);

    expect(await PrizePoolWinnerModel.countDocuments({ dayKey: '2026-04-23' })).toBe(1);
  });
});
