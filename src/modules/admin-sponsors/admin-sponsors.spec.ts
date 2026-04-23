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
import { BrandSponsorModel } from '../../shared/models/BrandSponsor.model.js';
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

describe('admin-sponsors routes', () => {
  const app = createApp();

  it('POST / creates a sponsor + audits, GET / returns the row', async () => {
    const seed = await seedAdminSession({ role: 'CONTENT_ADMIN' });

    const create = await request(app)
      .post('/api/v1/admin/sponsors')
      .set('Cookie', seed.cookieHeader)
      .set(seed.csrfHeaderName, seed.csrfToken)
      .send({
        slot: 1,
        imageUrl: 'https://cdn.example.com/sponsor-1.png',
        linkUrl: 'https://sponsor.example.com',
        priority: 10,
      });
    expect(create.status).toBe(200);
    expect(create.body.data.slot).toBe(1);

    const list = await request(app)
      .get('/api/v1/admin/sponsors?slot=1')
      .set('Cookie', seed.cookieHeader);
    expect(list.status).toBe(200);
    expect(list.body.data.items.length).toBe(1);

    const audit = await AuditLogModel.findOne({ action: 'SPONSOR_CREATE' });
    expect(audit).toBeTruthy();
    expect(audit?.resource?.kind).toBe('BrandSponsor');
  });

  it('PATCH /:id updates specific fields and captures before/after', async () => {
    const sponsor = await BrandSponsorModel.create({
      slot: 2,
      imageUrl: 'https://cdn.example.com/old.png',
      status: 'ACTIVE',
      priority: 5,
    });
    const seed = await seedAdminSession({ role: 'CONTENT_ADMIN' });

    const res = await request(app)
      .patch(`/api/v1/admin/sponsors/${sponsor._id}`)
      .set('Cookie', seed.cookieHeader)
      .set(seed.csrfHeaderName, seed.csrfToken)
      .send({ status: 'PAUSED', priority: 100 });
    expect(res.status).toBe(200);

    const reloaded = await BrandSponsorModel.findById(sponsor._id);
    expect(reloaded?.status).toBe('PAUSED');
    expect(reloaded?.priority).toBe(100);
    expect(reloaded?.imageUrl).toBe('https://cdn.example.com/old.png');

    const audit = await AuditLogModel.findOne({ action: 'SPONSOR_UPDATE' });
    expect((audit?.before as { status?: string } | null)?.status).toBe('ACTIVE');
    expect((audit?.after as { status?: string } | null)?.status).toBe('PAUSED');
  });

  it('rejects SUPPORT_ADMIN on writes (CONTENT/SUPER only)', async () => {
    const support = await seedAdminSession({ role: 'SUPPORT_ADMIN' });
    const res = await request(app)
      .post('/api/v1/admin/sponsors')
      .set('Cookie', support.cookieHeader)
      .set(support.csrfHeaderName, support.csrfToken)
      .send({ slot: 1, imageUrl: 'https://cdn.example.com/x.png' });
    expect(res.status).toBe(403);
  });
});
