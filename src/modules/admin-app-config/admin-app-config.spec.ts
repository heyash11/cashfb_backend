import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import {
  clearAllCollections,
  connectTestMongo,
  disconnectTestMongo,
} from '../../../test/testing/mongo.js';
import { seedAdminSession } from '../../../test/testing/admin-session-seed.js';
import { AppConfigModel } from '../../shared/models/AppConfig.model.js';
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

describe('admin-app-config routes', () => {
  const app = createApp();

  it('PATCH / sets specific fields; GET / returns updated doc + audit captures delta', async () => {
    await AppConfigModel.create({ key: 'default', baseRatePerVote: 100, maintenanceMode: false });
    const seed = await seedAdminSession({ role: 'SUPER_ADMIN' });

    const patch = await request(app)
      .patch('/api/v1/admin/app-config')
      .set('Cookie', seed.cookieHeader)
      .set(seed.csrfHeaderName, seed.csrfToken)
      .send({ maintenanceMode: true, baseRatePerVote: 150 });
    expect(patch.status).toBe(200);
    expect(patch.body.data.maintenanceMode).toBe(true);
    expect(patch.body.data.baseRatePerVote).toBe(150);

    const get = await request(app).get('/api/v1/admin/app-config').set('Cookie', seed.cookieHeader);
    expect(get.status).toBe(200);
    expect(get.body.data.maintenanceMode).toBe(true);
    // Fields not in the patch are left at their original value.
    expect(get.body.data.baseRatePerVote).toBe(150);
  });

  it('rejects CONTENT_ADMIN with 403, rejects unknown keys with 400', async () => {
    await AppConfigModel.create({ key: 'default' });

    const content = await seedAdminSession({ role: 'CONTENT_ADMIN' });
    const wrongRole = await request(app)
      .patch('/api/v1/admin/app-config')
      .set('Cookie', content.cookieHeader)
      .set(content.csrfHeaderName, content.csrfToken)
      .send({ maintenanceMode: true });
    expect(wrongRole.status).toBe(403);

    const superSeed = await seedAdminSession({ role: 'SUPER_ADMIN' });
    const unknownKey = await request(app)
      .patch('/api/v1/admin/app-config')
      .set('Cookie', superSeed.cookieHeader)
      .set(superSeed.csrfHeaderName, superSeed.csrfToken)
      .send({ notARealField: 'lol' });
    expect(unknownKey.status).toBe(400);
    expect(unknownKey.body.error.code).toBe('VALIDATION_FAILED');
  });
});
