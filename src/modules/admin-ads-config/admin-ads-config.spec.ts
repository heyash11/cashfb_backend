import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import {
  clearAllCollections,
  connectTestMongo,
  disconnectTestMongo,
} from '../../../test/testing/mongo.js';
import { seedAdminSession } from '../../../test/testing/admin-session-seed.js';
import { AdsConfigModel } from '../../shared/models/AdsConfig.model.js';
import { AuditLogModel } from '../../shared/models/AuditLog.model.js';
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

describe('admin-ads-config routes', () => {
  const app = createApp();

  it('PUT /:placementKey upserts as SUPER_ADMIN and records audit row', async () => {
    const seed = await seedAdminSession({ role: 'SUPER_ADMIN' });

    const res = await request(app)
      .put('/api/v1/admin/ads-config/banner_home')
      .set('Cookie', seed.cookieHeader)
      .set(seed.csrfHeaderName, seed.csrfToken)
      .send({
        type: 'BANNER',
        network: 'ADMOB',
        adUnitIdAndroid: 'ca-app-pub-TEST/android-1',
        enabled: true,
        minTierToHide: 'PRO_MAX',
      });

    expect(res.status).toBe(200);
    expect(res.body.data.placementKey).toBe('banner_home');
    expect(res.body.data.network).toBe('ADMOB');
    expect(res.body.data.enabled).toBe(true);

    const row = await AdsConfigModel.findOne({ placementKey: 'banner_home' });
    expect(row?.minTierToHide).toBe('PRO_MAX');
    expect(row?.updatedBy?.toString()).toBe(seed.adminId);

    const audit = await AuditLogModel.findOne({ action: 'ADS_CONFIG_UPSERT' });
    expect(audit).toBeTruthy();
    expect(audit?.resource?.kind).toBe('AdsConfig');
  });

  it('rejects CONTENT_ADMIN on every endpoint (SUPER_ADMIN only)', async () => {
    const content = await seedAdminSession({ role: 'CONTENT_ADMIN' });

    const list = await request(app)
      .get('/api/v1/admin/ads-config')
      .set('Cookie', content.cookieHeader);
    expect(list.status).toBe(403);

    const put = await request(app)
      .put('/api/v1/admin/ads-config/rewarded_home')
      .set('Cookie', content.cookieHeader)
      .set(content.csrfHeaderName, content.csrfToken)
      .send({ type: 'REWARDED_VIDEO', network: 'UNITY' });
    expect(put.status).toBe(403);
  });

  it('DELETE /:placementKey removes the row and records DELETE audit', async () => {
    const seed = await seedAdminSession({ role: 'SUPER_ADMIN' });
    await AdsConfigModel.create({
      placementKey: 'to_delete',
      type: 'BANNER',
      network: 'ADMOB',
      enabled: true,
    });

    const res = await request(app)
      .delete('/api/v1/admin/ads-config/to_delete')
      .set('Cookie', seed.cookieHeader)
      .set(seed.csrfHeaderName, seed.csrfToken);

    expect(res.status).toBe(200);
    expect(await AdsConfigModel.countDocuments({ placementKey: 'to_delete' })).toBe(0);

    const audit = await AuditLogModel.findOne({ action: 'ADS_CONFIG_DELETE' });
    expect(audit).toBeTruthy();
    expect((audit?.before as { placementKey?: string } | null)?.placementKey).toBe('to_delete');
  });
});
