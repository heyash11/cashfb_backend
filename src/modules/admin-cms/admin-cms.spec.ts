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
import { CmsContentModel } from '../../shared/models/CmsContent.model.js';
import { MODELS } from '../../shared/models/index.js';

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

describe('admin-cms routes', () => {
  const app = createApp();

  it('PUT /:key upserts, bumps version, audits before/after', async () => {
    const seed = await seedAdminSession({ role: 'CONTENT_ADMIN' });

    // First write (create).
    const first = await request(app)
      .put('/api/v1/admin/cms/TERMS')
      .set('Cookie', seed.cookieHeader)
      .set(seed.csrfHeaderName, seed.csrfToken)
      .send({ html: '<p>v1</p>' });
    expect(first.status).toBe(200);
    expect(first.body.data.version).toBe(1);
    expect(first.body.data.html).toBe('<p>v1</p>');

    // Second write (update).
    const second = await request(app)
      .put('/api/v1/admin/cms/TERMS')
      .set('Cookie', seed.cookieHeader)
      .set(seed.csrfHeaderName, seed.csrfToken)
      .send({ html: '<p>v2</p>' });
    expect(second.status).toBe(200);
    expect(second.body.data.version).toBe(2);

    const row = await CmsContentModel.findOne({ key: 'TERMS' });
    expect(row?.html).toBe('<p>v2</p>');
    expect(row?.updatedBy?.toString()).toBe(seed.adminId);

    const audits = await AuditLogModel.find({ action: 'CMS_UPSERT' }).sort({ createdAt: 1 });
    expect(audits.length).toBe(2);
    expect((audits[0]?.before as unknown) ?? null).toBeNull();
    expect((audits[1]?.before as { version?: number } | null)?.version).toBe(1);
    expect((audits[1]?.after as { version?: number } | null)?.version).toBe(2);
  });

  it('rejects SUPPORT_ADMIN on write and non-enum key with 400', async () => {
    const support = await seedAdminSession({ role: 'SUPPORT_ADMIN' });
    const wrongRole = await request(app)
      .put('/api/v1/admin/cms/TERMS')
      .set('Cookie', support.cookieHeader)
      .set(support.csrfHeaderName, support.csrfToken)
      .send({ html: '<p>blocked</p>' });
    expect(wrongRole.status).toBe(403);

    const content = await seedAdminSession({ role: 'CONTENT_ADMIN' });
    const badKey = await request(app)
      .put('/api/v1/admin/cms/NOT_A_KEY')
      .set('Cookie', content.cookieHeader)
      .set(content.csrfHeaderName, content.csrfToken)
      .send({ html: '<p>x</p>' });
    expect(badKey.status).toBe(400);
    expect(badKey.body.error.code).toBe('VALIDATION_FAILED');
  });
});
