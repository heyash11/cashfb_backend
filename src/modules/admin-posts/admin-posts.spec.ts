import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
import { PostModel } from '../../shared/models/Post.model.js';

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

describe('admin-posts routes', () => {
  const app = createApp();

  it('POST / creates a post with full middleware chain and writes an audit log', async () => {
    const { cookieHeader, csrfToken, csrfHeaderName, adminId } = await seedAdminSession({
      role: 'CONTENT_ADMIN',
      email: 'content@cashfb.test',
    });

    const body = {
      title: 'Daily trivia',
      dayKey: '2026-04-23',
      scheduledAt: '2026-04-23T10:00:00.000Z',
      tierRequired: 'PUBLIC',
    };

    const res = await request(app)
      .post('/api/v1/admin/posts')
      .set('Cookie', cookieHeader)
      .set(csrfHeaderName, csrfToken)
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.title).toBe('Daily trivia');
    expect(res.body.data._id).toBeTruthy();

    const postRow = await PostModel.findById(res.body.data._id);
    expect(postRow).toBeTruthy();

    const auditRows = await AuditLogModel.find({ action: 'POST_CREATE' });
    expect(auditRows.length).toBe(1);
    expect(auditRows[0]?.actorId.toHexString()).toBe(adminId);
    expect(auditRows[0]?.resource?.kind).toBe('Post');
    expect(auditRows[0]?.after).toBeTruthy();
  });

  it('rejects with 401 when no session cookie is present, 403 when role is wrong', async () => {
    // No session → 401.
    const noSession = await request(app).get('/api/v1/admin/posts?dayKey=2026-04-23');
    expect(noSession.status).toBe(401);
    expect(noSession.body.error.code).toBe('UNAUTHORIZED');

    // Wrong role (SUPPORT_ADMIN is not in the allowlist for posts).
    const seed = await seedAdminSession({ role: 'SUPPORT_ADMIN' });
    const wrongRole = await request(app)
      .get('/api/v1/admin/posts?dayKey=2026-04-23')
      .set('Cookie', seed.cookieHeader);
    expect(wrongRole.status).toBe(403);
    expect(wrongRole.body.error.code).toBe('FORBIDDEN');
  });

  it('PATCH / captures both before and after snapshots in audit_logs', async () => {
    const seed = await seedAdminSession({ role: 'SUPER_ADMIN' });
    const created = await PostModel.create({
      title: 'Original',
      dayKey: '2026-04-23',
      scheduledAt: new Date('2026-04-23T10:00:00.000Z'),
      tierRequired: 'PUBLIC',
      createdBy: seed.adminId,
    });

    const res = await request(app)
      .patch(`/api/v1/admin/posts/${created._id}`)
      .set('Cookie', seed.cookieHeader)
      .set(seed.csrfHeaderName, seed.csrfToken)
      .send({ title: 'Updated' });

    expect(res.status).toBe(200);
    expect(res.body.data.title).toBe('Updated');

    const audit = await AuditLogModel.findOne({ action: 'POST_UPDATE' });
    expect(audit).toBeTruthy();
    expect((audit?.before as { title?: string } | null)?.title).toBe('Original');
    expect((audit?.after as { title?: string } | null)?.title).toBe('Updated');
  });
});
