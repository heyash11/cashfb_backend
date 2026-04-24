import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  clearAllCollections,
  connectTestMongo,
  disconnectTestMongo,
} from '../../test/testing/mongo.js';
import { AuditLogModel } from '../shared/models/AuditLog.model.js';
import { PrizePoolWinnerModel } from '../shared/models/PrizePoolWinner.model.js';
import { UserModel, type UserAttrs } from '../shared/models/User.model.js';
import { type ForceLogoutStore } from '../shared/services/force-logout.js';
import { createUserAnonymizeSweepHandler } from './user-anonymize-sweep.worker.js';

/**
 * Phase 9 Chunk 4 — sweep worker unit coverage. Runs against the
 * shared MongoMemoryReplSet (transactions required). We inject a
 * `findCandidates` seam to drive the sweep eligibility logic
 * without fighting the 30-day real-time clock.
 */

class FakeForceLogoutStore {
  async clear(): Promise<void> {}
  async forceLogout(): Promise<number> {
    return 0;
  }
  async getCutoff(): Promise<number | null> {
    return null;
  }
  async assertNotForceLoggedOut(): Promise<void> {}
}

beforeAll(async () => {
  await connectTestMongo();
}, 30_000);

afterAll(async () => {
  await disconnectTestMongo();
});

beforeEach(async () => {
  await clearAllCollections();
});

async function seedUser(overrides: Partial<UserAttrs> = {}): Promise<UserAttrs> {
  const created = await UserModel.create({
    phone: `+91${Math.floor(Math.random() * 1_000_000_000)}`,
    dob: new Date('1995-01-01'),
    declaredState: 'IN-MH',
    tier: 'PUBLIC',
    ...overrides,
  });
  return created.toObject() as UserAttrs;
}

describe('createUserAnonymizeSweepHandler', () => {
  it('eligibility filter: real findCandidates picks >30d-old + skips held + skips not-yet-expired', async () => {
    // seed 3 users:
    //   eligible     deletedAt = 31d ago, no hold
    //   held         deletedAt = 31d ago, erasureHold.active = true
    //   not-expired  deletedAt = 15d ago
    const thirtyOneDaysAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    const fifteenDaysAgo = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);

    const eligible = await seedUser({ deletedAt: thirtyOneDaysAgo });
    const held = await seedUser({
      deletedAt: thirtyOneDaysAgo,
      erasureHold: { active: true, reason: 'legal review pending', at: new Date() },
    });
    const notExpired = await seedUser({ deletedAt: fifteenDaysAgo });

    // Exercise the real default findCandidates (no dep injected).
    const handler = createUserAnonymizeSweepHandler({
      forceLogoutStore: new FakeForceLogoutStore() as unknown as ForceLogoutStore,
    });
    const report = await handler({ scheduledFor: new Date().toISOString() });

    expect(report.candidateCount).toBe(1);
    expect(report.anonymizedCount).toBe(1);

    const eligibleFresh = await UserModel.findById(eligible._id);
    expect(eligibleFresh?.anonymizedAt).toBeTruthy();
    expect(eligibleFresh?.displayName).toBe('REDACTED_USER');

    const heldFresh = await UserModel.findById(held._id);
    expect(heldFresh?.anonymizedAt).toBeFalsy();

    const notExpiredFresh = await UserModel.findById(notExpired._id);
    expect(notExpiredFresh?.anonymizedAt).toBeFalsy();
  });

  it('ERASURE_WITH_PENDING_WINNINGS audit row: written with tdsAccruedPaise + gracePeriodStartedAt when PENDING winners exist', async () => {
    const user = await seedUser({ deletedAt: new Date('2026-03-15T00:00:00Z') });

    // Two PENDING winners: 5000 paise + 10000 paise final, TDS
    // 1500 + 3000 paise accrued.
    await PrizePoolWinnerModel.create([
      {
        dayKey: '2026-04-10',
        userId: user._id,
        type: 'GIFT_CODE',
        tier: 'PUBLIC',
        finalAmount: 5000,
        tdsDeducted: 1500,
        payoutStatus: 'PENDING',
      },
      {
        dayKey: '2026-04-15',
        userId: user._id,
        type: 'GIFT_CODE',
        tier: 'PUBLIC',
        finalAmount: 10_000,
        tdsDeducted: 3000,
        payoutStatus: 'PENDING',
      },
    ]);

    // Inject findCandidates so the 30d real-clock gate is bypassed.
    const now = new Date('2026-04-24T02:10:00Z');
    const handler = createUserAnonymizeSweepHandler({
      forceLogoutStore: new FakeForceLogoutStore() as unknown as ForceLogoutStore,
      findCandidates: async () => [user],
    });

    const report = await handler({ scheduledFor: now.toISOString() });
    expect(report.anonymizedCount).toBe(1);
    expect(report.pendingWinningsAuditCount).toBe(1);

    const audit = await AuditLogModel.findOne({ action: 'ERASURE_WITH_PENDING_WINNINGS' }).lean();
    expect(audit).toBeTruthy();
    expect(audit?.actorId.toString()).toBe(user._id.toString());
    expect(audit?.actorEmail).toBe('system:anonymize-sweep');
    const after = (audit?.after ?? {}) as Record<string, unknown>;
    expect(after.userId).toBe(user._id.toHexString());
    expect(after.pendingWinnerCount).toBe(2);
    expect(after.pendingTotalPaise).toBe(15_000);
    expect(after.tdsAccruedPaise).toBe(4500);
    expect(after.pendingDayKeys).toEqual(['2026-04-10', '2026-04-15']);
    expect(after.gracePeriodStartedAt).toBeTruthy();
    expect(after.anonymizedAt).toBeTruthy();
  });
});
