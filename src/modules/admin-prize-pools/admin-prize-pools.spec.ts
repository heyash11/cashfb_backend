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
import { PrizePoolModel } from '../../shared/models/PrizePool.model.js';
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

describe('admin-prize-pools routes', () => {
  const app = createApp();

  it('GET / returns the pool ledger for PAYMENT_ADMIN', async () => {
    await PrizePoolModel.create({
      dayKey: '2026-04-24',
      yesterdayVoteCount: 500,
      baseRate: 100,
      totalPool: 50000,
      giftCodeBudget: 35000,
      customRoomBudget: 15000,
      status: 'CALCULATED',
    });
    const seed = await seedAdminSession({ role: 'PAYMENT_ADMIN' });

    const res = await request(app)
      .get('/api/v1/admin/prize-pools')
      .set('Cookie', seed.cookieHeader);

    expect(res.status).toBe(200);
    expect(res.body.data.items.length).toBe(1);
    expect(res.body.data.items[0].dayKey).toBe('2026-04-24');
  });

  it('POST /winners/:id/mark-payout flips PENDING → RELEASED and audits the delta', async () => {
    const winner = await PrizePoolWinnerModel.create({
      dayKey: '2026-04-24',
      userId: new Types.ObjectId(),
      type: 'GIFT_CODE',
      tier: 'PRO',
      baseAmount: 50,
      multiplier: 5,
      finalAmount: 250,
      tdsDeducted: 0,
      payoutStatus: 'PENDING',
    });
    const seed = await seedAdminSession({ role: 'PAYMENT_ADMIN' });

    const res = await request(app)
      .post(`/api/v1/admin/prize-pools/winners/${winner._id}/mark-payout`)
      .set('Cookie', seed.cookieHeader)
      .set(seed.csrfHeaderName, seed.csrfToken)
      .send({
        payoutStatus: 'RELEASED',
        challanNo: 'TDS-2026-04-0001',
        panLast4: '4567',
        reason: 'manual release after TDS challan reconciliation',
      });

    expect(res.status).toBe(200);

    const reloaded = await PrizePoolWinnerModel.findById(winner._id);
    expect(reloaded?.payoutStatus).toBe('RELEASED');
    expect(reloaded?.tdsChallanNo).toBe('TDS-2026-04-0001');
    expect(reloaded?.panAtPayout).toBe('XXXXX4567');
    expect(reloaded?.releasedAt).toBeTruthy();

    const audit = await AuditLogModel.findOne({ action: 'PRIZE_POOL_WINNER_MARK_PAYOUT' });
    expect(audit).toBeTruthy();
    expect((audit?.before as { payoutStatus?: string } | null)?.payoutStatus).toBe('PENDING');
    expect((audit?.after as { payoutStatus?: string } | null)?.payoutStatus).toBe('RELEASED');
    // PAN is last-4 masked, not a sensitive redacted field, so it
    // flows through the audit log as-is.
    expect((audit?.after as { panAtPayout?: string } | null)?.panAtPayout).toBe('XXXXX4567');
  });

  it('rejects PAYMENT_ADMIN on POST /run (SUPER_ADMIN only), 401 without session', async () => {
    const noSession = await request(app).post('/api/v1/admin/prize-pools/run').send({
      dayKey: '2026-04-24',
      yesterdayDayKey: '2026-04-23',
      reason: 'manual re-run after cron miss',
    });
    expect(noSession.status).toBe(401);

    const payment = await seedAdminSession({ role: 'PAYMENT_ADMIN' });
    const wrongRole = await request(app)
      .post('/api/v1/admin/prize-pools/run')
      .set('Cookie', payment.cookieHeader)
      .set(payment.csrfHeaderName, payment.csrfToken)
      .send({
        dayKey: '2026-04-24',
        yesterdayDayKey: '2026-04-23',
        reason: 'manual re-run after cron miss',
      });
    expect(wrongRole.status).toBe(403);
  });
});
