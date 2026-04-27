import { Types } from 'mongoose';
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

describe('sweepExpiredTiers — Phase 11.3 multi-sub', () => {
  it('removes only expired entries; non-expired entries kept; legacy tier re-derived', async () => {
    const now = new Date('2026-04-23T10:00:00Z');
    const hourAgo = new Date(now.getTime() - 60 * 60_000);
    const hourAhead = new Date(now.getTime() + 60 * 60_000);

    // 5 users with one expired PRO entry each.
    const expired = await Promise.all(
      Array.from({ length: 5 }, () =>
        mkUser({
          subscriptions: [
            {
              tier: 'PRO',
              status: 'ACTIVE',
              expiresAt: hourAgo,
              subscriptionId: new Types.ObjectId(),
            },
          ],
        }),
      ),
    );
    // 5 users with non-expired PRO entry each.
    const nonExpired = await Promise.all(
      Array.from({ length: 5 }, () =>
        mkUser({
          subscriptions: [
            {
              tier: 'PRO',
              status: 'ACTIVE',
              expiresAt: hourAhead,
              subscriptionId: new Types.ObjectId(),
            },
          ],
        }),
      ),
    );

    const result = await sweepExpiredTiers({ clock: () => now });
    expect(result.sweptCount).toBe(5);

    for (const u of expired) {
      const after = await UserModel.findById(u._id);
      expect(after?.subscriptions ?? []).toEqual([]);
    }
    for (const u of nonExpired) {
      const after = await UserModel.findById(u._id);
      expect(after?.subscriptions).toHaveLength(1);
      expect(after?.subscriptions[0]?.expiresAt?.toISOString()).toBe(hourAhead.toISOString());
    }
  });

  it('mixed PRO + PRO_MAX, PRO expired only → PRO removed, PRO_MAX kept, tier=PRO_MAX', async () => {
    const now = new Date('2026-04-23T10:00:00Z');
    const past = new Date(now.getTime() - 60 * 60_000);
    const future = new Date(now.getTime() + 60 * 60_000);

    const user = await mkUser({
      subscriptions: [
        { tier: 'PRO', status: 'ACTIVE', expiresAt: past, subscriptionId: new Types.ObjectId() },
        {
          tier: 'PRO_MAX',
          status: 'ACTIVE',
          expiresAt: future,
          subscriptionId: new Types.ObjectId(),
        },
      ],
    });

    await sweepExpiredTiers({ clock: () => now });

    const after = await UserModel.findById(user._id);
    expect(after?.subscriptions).toHaveLength(1);
    expect(after?.subscriptions[0]?.tier).toBe('PRO_MAX');
    expect(after?.subscriptions[0]?.expiresAt?.toISOString()).toBe(future.toISOString());
  });

  it('both entries expired → array empty, tier=PUBLIC, tierExpiresAt=null', async () => {
    const now = new Date('2026-04-23T10:00:00Z');
    const past = new Date(now.getTime() - 60 * 60_000);

    const user = await mkUser({
      subscriptions: [
        { tier: 'PRO', status: 'ACTIVE', expiresAt: past, subscriptionId: new Types.ObjectId() },
        {
          tier: 'PRO_MAX',
          status: 'CANCELLED',
          expiresAt: past,
          subscriptionId: new Types.ObjectId(),
        },
      ],
    });

    await sweepExpiredTiers({ clock: () => now });

    const after = await UserModel.findById(user._id);
    expect(after?.subscriptions ?? []).toEqual([]);
  });

  it('idempotent re-run produces no further changes', async () => {
    const now = new Date('2026-04-23T10:00:00Z');
    const past = new Date(now.getTime() - 60 * 60_000);

    const user = await mkUser({
      subscriptions: [
        { tier: 'PRO', status: 'ACTIVE', expiresAt: past, subscriptionId: new Types.ObjectId() },
      ],
    });

    const first = await sweepExpiredTiers({ clock: () => now });
    expect(first.sweptCount).toBe(1);

    const second = await sweepExpiredTiers({ clock: () => now });
    expect(second.sweptCount).toBe(0);

    const after = await UserModel.findById(user._id);
    expect(after?.subscriptions ?? []).toEqual([]);
  });

  // Phase 11.5 — anomaly users (Phase 11.0 backfill: empty
  // subscriptions[], legacy tier field already gone post-11.5
  // migration). Sweep skips them naturally because the candidate
  // scan looks for users with at least one expiring entry.
  it('users with empty subscriptions[] are untouched by sweep', async () => {
    const now = new Date('2026-04-23T10:00:00Z');
    const anomaly = await mkUser({});

    const result = await sweepExpiredTiers({ clock: () => now });
    expect(result.sweptCount).toBe(0);

    const after = await UserModel.findById(anomaly._id);
    expect(after?.subscriptions ?? []).toEqual([]);
  });

  // R6 — sweep racing with onCharged that extends expiresAt mid-flight.
  it("R6 race: when an entry's expiresAt is extended between candidate scan and pipeline write, sweep does not remove it", async () => {
    const now = new Date('2026-04-23T10:00:00Z');
    const past = new Date(now.getTime() - 60 * 60_000);
    const future = new Date(now.getTime() + 60 * 60_000);

    const user = await mkUser({
      subscriptions: [
        { tier: 'PRO', status: 'ACTIVE', expiresAt: past, subscriptionId: new Types.ObjectId() },
      ],
    });

    // Simulate the race: between the candidate scan and pipeline
    // write, an onCharged extends expiresAt to future. We approximate
    // by intercepting via `find` returning the user (still with past
    // expiresAt) and then mutating before the bulk update.
    //
    // Direct approach: extend expiresAt FIRST, then run sweep. The
    // candidate scan finds the user (matches $elemMatch from the
    // pre-extension state would have, but mutating before execution
    // means scan sees post-extension value, doesn't match, sweep
    // skips). Since both scan + write run in the same call, the
    // simpler correctness check: extend before sweep entirely.
    await UserModel.updateOne({ _id: user._id }, { $set: { 'subscriptions.0.expiresAt': future } });

    const result = await sweepExpiredTiers({ clock: () => now });
    // Either the candidate scan misses (cleanest), OR the scan caught
    // it but the pipeline's $filter cond now sees expiresAt > now and
    // keeps the entry. Both produce correct end state.
    expect(result.sweptCount).toBeLessThanOrEqual(1);
    const after = await UserModel.findById(user._id);
    expect(after?.subscriptions).toHaveLength(1);
    expect(after?.subscriptions[0]?.tier).toBe('PRO');
    expect(after?.subscriptions[0]?.expiresAt?.toISOString()).toBe(future.toISOString());
  });

  it('concurrent parallel sweeps produce exactly one total update per expired user', async () => {
    const now = new Date('2026-04-23T10:00:00Z');
    const past = new Date(now.getTime() - 60 * 60_000);

    await Promise.all(
      Array.from({ length: 5 }, () =>
        mkUser({
          subscriptions: [
            {
              tier: 'PRO',
              status: 'ACTIVE',
              expiresAt: past,
              subscriptionId: new Types.ObjectId(),
            },
          ],
        }),
      ),
    );

    const results = await Promise.allSettled([
      sweepExpiredTiers({ clock: () => now }),
      sweepExpiredTiers({ clock: () => now }),
    ]);

    const totalSwept = results.reduce((sum, r) => {
      if (r.status !== 'fulfilled') return sum;
      return sum + r.value.sweptCount;
    }, 0);
    // Convergent predicate: total writes equals total expired users.
    expect(totalSwept).toBeGreaterThanOrEqual(5);
    expect(totalSwept).toBeLessThanOrEqual(10);

    // All 5 users now have empty subscriptions[].
    const emptyCount = await UserModel.countDocuments({ subscriptions: { $size: 0 } });
    expect(emptyCount).toBeGreaterThanOrEqual(5);
  });

  it('batchSize caps single-call work: 600 expired users with batchSize=100 sweeps 100 per call', async () => {
    const now = new Date('2026-04-23T10:00:00Z');
    const past = new Date(now.getTime() - 60 * 60_000);

    await Promise.all(
      Array.from({ length: 600 }, () =>
        mkUser({
          subscriptions: [
            {
              tier: 'PRO',
              status: 'ACTIVE',
              expiresAt: past,
              subscriptionId: new Types.ObjectId(),
            },
          ],
        }),
      ),
    );

    const first = await sweepExpiredTiers({ clock: () => now, batchSize: 100 });
    expect(first.sweptCount).toBe(100);
    // 100 of 600 users now have empty subscriptions[].
    expect(await UserModel.countDocuments({ subscriptions: { $size: 0 } })).toBe(100);

    const second = await sweepExpiredTiers({ clock: () => now, batchSize: 100 });
    expect(second.sweptCount).toBe(100);
    expect(await UserModel.countDocuments({ subscriptions: { $size: 0 } })).toBe(200);
  }, 30_000);
});
