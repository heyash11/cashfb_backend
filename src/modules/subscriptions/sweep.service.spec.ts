import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  clearAllCollections,
  connectTestMongo,
  disconnectTestMongo,
} from '../../../test/testing/mongo.js';
import { MODELS } from '../../shared/models/index.js';
import { UserModel, type UserAttrs } from '../../shared/models/User.model.js';
import { sweepExpiredTiers } from './sweep.service.js';

type AnyModel = { syncIndexes(): Promise<string[]> };

let phoneCounter = 0;
async function mkUser(overrides: Partial<UserAttrs> = {}): Promise<UserAttrs> {
  phoneCounter += 1;
  const suffix = String(phoneCounter).padStart(8, '0');
  const doc = await UserModel.create({
    phone: `+9188${suffix}`,
    dob: new Date('1995-01-01'),
    declaredState: 'IN-MH',
    ...overrides,
  });
  return doc.toObject();
}

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

describe('sweepExpiredTiers', () => {
  it('flips expired PRO/PRO_MAX users to PUBLIC with tierExpiresAt null; non-expired and already-PUBLIC users untouched', async () => {
    const now = new Date('2026-04-23T10:00:00Z');
    const hourAgo = new Date(now.getTime() - 60 * 60_000);
    const hourAhead = new Date(now.getTime() + 60 * 60_000);

    // 5 expired (should be swept).
    const expired = await Promise.all(
      Array.from({ length: 5 }, () => mkUser({ tier: 'PRO', tierExpiresAt: hourAgo })),
    );
    // 5 non-expired (should remain PRO).
    const nonExpired = await Promise.all(
      Array.from({ length: 5 }, () => mkUser({ tier: 'PRO', tierExpiresAt: hourAhead })),
    );
    // 1 already-PUBLIC (should be untouched — no write).
    const publicUser = await mkUser({ tier: 'PUBLIC' });

    const result = await sweepExpiredTiers({ clock: () => now });
    expect(result.sweptCount).toBe(5);

    for (const u of expired) {
      const after = await UserModel.findById(u._id);
      expect(after?.tier).toBe('PUBLIC');
      expect(after?.tierExpiresAt).toBeNull();
    }
    for (const u of nonExpired) {
      const after = await UserModel.findById(u._id);
      expect(after?.tier).toBe('PRO');
      expect(after?.tierExpiresAt?.toISOString()).toBe(hourAhead.toISOString());
    }
    const pubAfter = await UserModel.findById(publicUser._id);
    expect(pubAfter?.tier).toBe('PUBLIC');
  });

  it('concurrent parallel sweeps produce exactly one total update per expired user (convergent predicate)', async () => {
    const now = new Date('2026-04-23T10:00:00Z');
    const hourAgo = new Date(now.getTime() - 60 * 60_000);
    const hourAhead = new Date(now.getTime() + 60 * 60_000);

    await Promise.all(
      Array.from({ length: 5 }, () => mkUser({ tier: 'PRO', tierExpiresAt: hourAgo })),
    );
    await Promise.all(
      Array.from({ length: 5 }, () => mkUser({ tier: 'PRO_MAX', tierExpiresAt: hourAhead })),
    );

    const results = await Promise.allSettled([
      sweepExpiredTiers({ clock: () => now }),
      sweepExpiredTiers({ clock: () => now }),
    ]);

    const totalSwept = results.reduce((sum, r) => {
      if (r.status !== 'fulfilled') return sum;
      return sum + r.value.sweptCount;
    }, 0);
    expect(totalSwept).toBe(5);

    const pubCount = await UserModel.countDocuments({ tier: 'PUBLIC' });
    expect(pubCount).toBe(5);
    const stillPro = await UserModel.countDocuments({ tier: 'PRO_MAX' });
    expect(stillPro).toBe(5);
  });

  it('batchSize caps single-call work: 600 expired users with batchSize=100 sweeps exactly 100 per call', async () => {
    const now = new Date('2026-04-23T10:00:00Z');
    const hourAgo = new Date(now.getTime() - 60 * 60_000);

    await Promise.all(
      Array.from({ length: 600 }, () => mkUser({ tier: 'PRO', tierExpiresAt: hourAgo })),
    );

    const first = await sweepExpiredTiers({ clock: () => now, batchSize: 100 });
    expect(first.sweptCount).toBe(100);

    const remainingPro = await UserModel.countDocuments({ tier: 'PRO' });
    expect(remainingPro).toBe(500);

    // Second call processes the next batch.
    const second = await sweepExpiredTiers({ clock: () => now, batchSize: 100 });
    expect(second.sweptCount).toBe(100);
    expect(await UserModel.countDocuments({ tier: 'PRO' })).toBe(400);
  }, 30_000);
});
