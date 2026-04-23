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
import { MODELS } from '../../shared/models/index.js';

type AnyModel = { syncIndexes(): Promise<string[]> };

async function seedAudit(
  action: string,
  actorId: Types.ObjectId,
  resourceKind?: string,
): Promise<void> {
  await AuditLogModel.create({
    actorId,
    actorEmail: 'seed-audit@cashfb.test',
    action,
    ...(resourceKind ? { resource: { kind: resourceKind, id: new Types.ObjectId() } } : {}),
    ip: '127.0.0.1',
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

describe('admin-audit-logs routes', () => {
  const app = createApp();

  it('GET / filters by action + resourceKind and returns matching rows', async () => {
    const actor = new Types.ObjectId();
    await seedAudit('USER_BLOCK', actor, 'User');
    await seedAudit('USER_BLOCK', actor, 'User');
    await seedAudit('POST_CREATE', actor, 'Post');
    await seedAudit('USER_COINS_ADJUST', actor, 'User');

    const seed = await seedAdminSession({ role: 'SUPER_ADMIN' });

    const byAction = await request(app)
      .get('/api/v1/admin/audit-logs?action=USER_BLOCK')
      .set('Cookie', seed.cookieHeader);
    expect(byAction.status).toBe(200);
    expect(byAction.body.data.items.length).toBe(2);
    expect(
      byAction.body.data.items.every((r: { action: string }) => r.action === 'USER_BLOCK'),
    ).toBe(true);

    const byKind = await request(app)
      .get('/api/v1/admin/audit-logs?resourceKind=User')
      .set('Cookie', seed.cookieHeader);
    expect(byKind.body.data.items.length).toBe(3);
    expect(
      byKind.body.data.items.every(
        (r: { resource?: { kind?: string } }) => r.resource?.kind === 'User',
      ),
    ).toBe(true);
  });

  it('rejects SUPPORT_ADMIN with 403 (SUPER_ADMIN only)', async () => {
    const support = await seedAdminSession({ role: 'SUPPORT_ADMIN' });
    const res = await request(app)
      .get('/api/v1/admin/audit-logs')
      .set('Cookie', support.cookieHeader);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });
});
