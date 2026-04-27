import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../../src/app.js';
import { seedAdminSession } from '../../testing/admin-session-seed.js';
import { AuditLogModel } from '../../../src/shared/models/AuditLog.model.js';
import { PostModel } from '../../../src/shared/models/Post.model.js';
import { connectHarness, disconnectHarness, resetFullState } from './_harness.js';

/**
 * Integration — admin HTTP write produces an audit_logs row with
 * the expected shape. Exercises the full middleware chain
 * (ipAllowlist → adminSession → csrfCheck → requireAnyRole →
 * auditLog) against the real docker Mongo + Redis, plus the
 * global error handler and app.ts route mounts.
 *
 * Complements the unit-level admin-posts.spec.ts which uses
 * MongoMemoryReplSet. This one is the regression guard that
 * would have caught the Chunk 1 missing-mongoose-connect bug.
 */
beforeAll(async () => {
  await connectHarness();
}, 30_000);

afterAll(async () => {
  await disconnectHarness();
});

beforeEach(async () => {
  await resetFullState();
});

describe('[integration] admin audit write', () => {
  const app = createApp();

  it('POST /admin/posts persists the post AND writes audit_logs row via real Mongo', async () => {
    const seed = await seedAdminSession({ role: 'CONTENT_ADMIN' });

    const res = await request(app)
      .post('/api/v1/admin/posts')
      .set('Cookie', seed.cookieHeader)
      .set(seed.csrfHeaderName, seed.csrfToken)
      .send({
        title: 'Integration post',
        dayKey: '2026-04-24',
        scheduledAt: '2026-04-24T10:00:00.000Z',
        tier: 'PUBLIC',
      });

    expect(res.status).toBe(200);
    expect(res.body.data.title).toBe('Integration post');

    const postRow = await PostModel.findById(res.body.data._id);
    expect(postRow).toBeTruthy();

    const audit = await AuditLogModel.findOne({ action: 'POST_CREATE' });
    expect(audit).toBeTruthy();
    expect(audit?.actorId.toHexString()).toBe(seed.adminId);
    expect(audit?.resource?.kind).toBe('Post');
    expect(audit?.ip).toBeTruthy();
  });
});
