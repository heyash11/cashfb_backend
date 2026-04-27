import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import {
  clearAllCollections,
  connectTestMongo,
  disconnectTestMongo,
} from '../../../test/testing/mongo.js';
import { __resetJwtKeysForTesting, initJwtKeys, signAccessToken } from '../../shared/jwt/signer.js';
import { MODELS } from '../../shared/models/index.js';
import { PrizePoolModel } from '../../shared/models/PrizePool.model.js';
import { UserModel } from '../../shared/models/User.model.js';
import { dayKeyIst, nowIst } from '../../shared/utils/date.js';

type AnyModel = { syncIndexes(): Promise<string[]> };

beforeAll(async () => {
  await connectTestMongo();
  await Promise.all(Object.values(MODELS).map((m) => (m as unknown as AnyModel).syncIndexes()));
  __resetJwtKeysForTesting();
  await initJwtKeys();
}, 120_000);

afterAll(async () => {
  await disconnectTestMongo();
});

beforeEach(async () => {
  await clearAllCollections();
});

async function seedAuthedUser(): Promise<{ token: string }> {
  const user = await UserModel.create({
    phone: `+9199${Math.floor(10000000 + Math.random() * 89999999)}`,
    dob: new Date('1995-01-01'),
    declaredState: 'IN-MH',
  });
  const token = await signAccessToken({
    sub: String(user._id),
    jti: `test-${user._id}`,
    tokenVersion: 1,
  });
  return { token };
}

describe('GET /api/v1/prize-pools/today — Phase 11.6 public read endpoint', () => {
  const app = createApp();

  it('returns 401 when no bearer token is provided', async () => {
    const res = await request(app).get('/api/v1/prize-pools/today?tier=PUBLIC');
    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe('UNAUTHORIZED');
  });

  it('returns 400 VALIDATION_FAILED when tier query param is missing', async () => {
    const { token } = await seedAuthedUser();
    const res = await request(app)
      .get('/api/v1/prize-pools/today')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('VALIDATION_FAILED');
  });

  it('returns 400 VALIDATION_FAILED when tier value is invalid', async () => {
    const { token } = await seedAuthedUser();
    const res = await request(app)
      .get('/api/v1/prize-pools/today?tier=GOLD')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('VALIDATION_FAILED');
  });

  it('returns 200 with PENDING projection when no pool row exists for today', async () => {
    const { token } = await seedAuthedUser();
    const res = await request(app)
      .get('/api/v1/prize-pools/today?tier=PUBLIC')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({
      tier: 'PUBLIC',
      status: 'PENDING',
      voteCount: 0,
      totalPoolPaise: 0,
      calculatedAt: null,
    });
    expect(res.body.data.dayKey).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('returns 200 with full numeric breakdown + status=CALCULATED when pool row exists', async () => {
    const { token } = await seedAuthedUser();
    const todayKey = dayKeyIst(nowIst());
    const calculatedAt = new Date('2026-04-26T00:05:00Z');
    await PrizePoolModel.create({
      tier: 'PUBLIC',
      dayKey: todayKey,
      yesterdayVoteCount: 25,
      baseRate: 100,
      totalPool: 4500, // 25 × 100 × 1 + 2000 donations
      giftCodeBudget: 3150,
      customRoomBudget: 1350,
      proMultiplier: 5,
      proMaxMultiplier: 10,
      status: 'CALCULATED',
      calculatedAt,
    });

    const res = await request(app)
      .get('/api/v1/prize-pools/today?tier=PUBLIC')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      tier: 'PUBLIC',
      dayKey: todayKey,
      voteCount: 25,
      tierMultiplier: 1,
      baseRatePaise: 100,
      voteContributionPaise: 2500,
      donationContributionPaise: 2000,
      totalPoolPaise: 4500,
      giftCodeBudgetPaise: 3150,
      customRoomBudgetPaise: 1350,
      status: 'CALCULATED',
    });
    expect(new Date(res.body.data.calculatedAt as string).toISOString()).toBe(
      calculatedAt.toISOString(),
    );
  });
});
