import { type Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  clearAllCollections,
  connectTestMongo,
  disconnectTestMongo,
} from '../../../test/testing/mongo.js';
import { UserModel } from '../../shared/models/User.model.js';
import { LoginSessionModel } from '../../shared/models/LoginSession.model.js';
import { LoginSessionRepository } from '../../shared/repositories/LoginSession.repository.js';
import { UserRepository } from '../../shared/repositories/User.repository.js';
import { type ForceLogoutStore } from '../../shared/services/force-logout.js';
import { UserErasureService } from './users.erasure.service.js';

/**
 * Phase 9 Chunk 4 — UserErasureService unit coverage against an
 * in-memory MongoMemoryReplSet (transactions on the revoke + update
 * paths need a replset). Force-logout store gets an injected
 * in-memory fake so we don't touch the shared Redis.
 */

class FakeForceLogoutStore {
  readonly cutoffs = new Map<string, number>();
  async forceLogout(userId: string): Promise<number> {
    const now = Math.floor(Date.now() / 1000);
    this.cutoffs.set(userId, now);
    return now;
  }
  async clear(userId: string): Promise<void> {
    this.cutoffs.delete(userId);
  }
  async getCutoff(userId: string): Promise<number | null> {
    return this.cutoffs.get(userId) ?? null;
  }
  async assertNotForceLoggedOut(): Promise<void> {
    /* not exercised here */
  }
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

async function seedUser(overrides: Partial<Record<string, unknown>> = {}): Promise<Types.ObjectId> {
  const user = await UserModel.create({
    phone: `+91${Math.floor(Math.random() * 1_000_000_000)}`,
    dob: new Date('1995-01-01'),
    declaredState: 'IN-MH',
    tier: 'PUBLIC',
    ...overrides,
  });
  return user._id;
}

function buildService(clockMs?: number): {
  svc: UserErasureService;
  fake: FakeForceLogoutStore;
} {
  const fake = new FakeForceLogoutStore();
  const clock = clockMs === undefined ? () => new Date() : () => new Date(clockMs);
  const svc = new UserErasureService({
    userRepo: new UserRepository(),
    sessionRepo: new LoginSessionRepository(),
    forceLogoutStore: fake as unknown as ForceLogoutStore,
    clock,
  });
  return { svc, fake };
}

describe('UserErasureService', () => {
  it('request: sets deletedAt, revokes sessions, writes force-logout cutoff', async () => {
    const userId = await seedUser();
    await LoginSessionModel.create([
      { userId, jti: 'jti-1', family: 'fam-1' },
      { userId, jti: 'jti-2', family: 'fam-1' },
    ]);

    const { svc, fake } = buildService();
    const status = await svc.request(userId);

    expect(status.requested).toBe(true);
    expect(status.deletedAt).toBeInstanceOf(Date);
    expect(status.daysRemaining).toBe(30);

    const updated = await UserModel.findById(userId);
    expect(updated?.deletedAt).toBeTruthy();

    const activeCount = await LoginSessionModel.countDocuments({
      userId,
      revokedAt: { $exists: false },
    });
    expect(activeCount).toBe(0);

    expect(fake.cutoffs.get(userId.toHexString())).toBeTypeOf('number');
  });

  it('request: idempotent when already requested — deletedAt does not move', async () => {
    const userId = await seedUser();
    const originalDeletedAt = new Date('2026-04-10T00:00:00Z');
    await UserModel.updateOne({ _id: userId }, { $set: { deletedAt: originalDeletedAt } });

    const { svc } = buildService(new Date('2026-04-20T00:00:00Z').getTime());
    const status = await svc.request(userId);

    expect(status.requested).toBe(true);
    expect(status.deletedAt?.toISOString()).toBe(originalDeletedAt.toISOString());

    const fresh = await UserModel.findById(userId);
    expect(fresh?.deletedAt?.toISOString()).toBe(originalDeletedAt.toISOString());
  });

  it('cancel: during grace — unsets deletedAt and clears force-logout key', async () => {
    const userId = await seedUser({ deletedAt: new Date('2026-04-15T00:00:00Z') });
    const { svc, fake } = buildService();
    await fake.forceLogout(userId.toHexString());

    const status = await svc.cancel(userId);
    expect(status.requested).toBe(false);

    const fresh = await UserModel.findById(userId);
    expect(fresh?.deletedAt).toBeUndefined();
    expect(fake.cutoffs.has(userId.toHexString())).toBe(false);
  });

  it('cancel: after anonymization — rejects with ALREADY_ANONYMIZED', async () => {
    const userId = await seedUser({
      deletedAt: new Date('2026-03-15T00:00:00Z'),
      anonymizedAt: new Date('2026-04-15T00:00:00Z'),
    });
    const { svc } = buildService();
    await expect(svc.cancel(userId)).rejects.toMatchObject({
      code: 'ALREADY_ANONYMIZED',
      httpStatus: 400,
    });
  });

  it('status: computes daysRemaining relative to clock', async () => {
    // deletedAt 10 days ago → 20 days remaining.
    const now = new Date('2026-04-24T00:00:00Z');
    const deletedAt = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);
    const userId = await seedUser({ deletedAt });

    const { svc } = buildService(now.getTime());
    const status = await svc.status(userId);

    expect(status.requested).toBe(true);
    expect(status.daysRemaining).toBe(20);
    expect(status.held).toBe(false);
  });
});
