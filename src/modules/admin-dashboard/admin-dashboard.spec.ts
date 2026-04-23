import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import {
  clearAllCollections,
  connectTestMongo,
  disconnectTestMongo,
} from '../../../test/testing/mongo.js';
import { seedAdminSession } from '../../../test/testing/admin-session-seed.js';
import { redis } from '../../config/redis.js';
import { MODELS } from '../../shared/models/index.js';
import { UserModel } from '../../shared/models/User.model.js';

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
  // Clear the metrics cache between tests so `cached: false` assertions
  // are deterministic. This key is spec-specific; no cross-spec risk.
  await redis.del('admin:dashboard:metrics');
});

describe('admin-dashboard routes', () => {
  const app = createApp();

  it('GET /metrics returns envelope with generatedAt + cached=false on first call, cached=true on second', async () => {
    await UserModel.create({
      phone: '9000000001',
      dob: new Date('1998-01-01'),
      declaredState: 'IN-MH',
    });
    const seed = await seedAdminSession({ role: 'SUPPORT_ADMIN' });

    const first = await request(app)
      .get('/api/v1/admin/dashboard/metrics')
      .set('Cookie', seed.cookieHeader);
    expect(first.status).toBe(200);
    expect(first.body.success).toBe(true);
    expect(first.body.data.users.total).toBe(1);
    expect(typeof first.body.generatedAt).toBe('string');
    expect(first.body.cached).toBe(false);

    const firstAt = first.body.generatedAt;

    const second = await request(app)
      .get('/api/v1/admin/dashboard/metrics')
      .set('Cookie', seed.cookieHeader);
    expect(second.status).toBe(200);
    expect(second.body.cached).toBe(true);
    // Cache preserves the original generatedAt — that's the point of
    // surfacing it: the UI can display "Data as of X" using the
    // moment the aggregation ran, not the moment we served it.
    expect(second.body.generatedAt).toBe(firstAt);
    expect(second.body.data.users.total).toBe(1);

    // Cache hit masks newly created users until TTL expires.
    await UserModel.create({
      phone: '9000000002',
      dob: new Date('1998-01-01'),
      declaredState: 'IN-MH',
    });
    const stale = await request(app)
      .get('/api/v1/admin/dashboard/metrics')
      .set('Cookie', seed.cookieHeader);
    expect(stale.body.cached).toBe(true);
    expect(stale.body.data.users.total).toBe(1);

    // Manual cache clear → next call recomputes.
    await redis.del('admin:dashboard:metrics');
    const fresh = await request(app)
      .get('/api/v1/admin/dashboard/metrics')
      .set('Cookie', seed.cookieHeader);
    expect(fresh.body.cached).toBe(false);
    expect(fresh.body.data.users.total).toBe(2);
  });

  it('rejects 401 without session; every admin role is allowed through when session is present', async () => {
    const noSession = await request(app).get('/api/v1/admin/dashboard/metrics');
    expect(noSession.status).toBe(401);

    const content = await seedAdminSession({ role: 'CONTENT_ADMIN' });
    const res = await request(app)
      .get('/api/v1/admin/dashboard/metrics')
      .set('Cookie', content.cookieHeader);
    expect(res.status).toBe(200);
  });
});
