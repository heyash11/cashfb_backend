import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  clearAllCollections,
  connectTestMongo,
  disconnectTestMongo,
} from '../../../test/testing/mongo.js';
import {
  buildDeriveTierExpiresAtPipelineExpr,
  buildDeriveTierPipelineExpr,
} from '../../modules/subscriptions/_subscriptions.pipelines.js';
import { UserModel } from './User.model.js';
import {
  deriveCurrentTier,
  deriveTierExpiresAt,
  type DerivationSubscriptionEntry,
  type Tier,
} from './_tier.js';

/**
 * Phase 11.3 §A9 — dual-implementation contract spec. The canonical
 * tier-derivation rule is implemented BOTH in JavaScript
 * (`deriveCurrentTier` / `deriveTierExpiresAt` in _tier.ts) AND as
 * a MongoDB aggregation-pipeline expression (in
 * modules/subscriptions/_subscriptions.pipelines.ts). The webhook
 * handlers and sweep use the pipeline; tests, /me-equivalents, and
 * future callers use the JS function.
 *
 * Drift between the two implementations would be a silent
 * correctness bug the moment either side moves. This spec runs the
 * 12-row canonical fixture matrix through both implementations and
 * asserts identical output. The matrix exercises the rule edges
 * specifically (Row 3 defensive past-expiresAt-but-still-ACTIVE,
 * Row 11 grace-vs-grace tier ordering) — the cases random fixtures
 * miss reliably.
 */

const NOW = new Date('2026-04-27T12:00:00Z');
const FUTURE = new Date('2027-01-01T00:00:00Z');
const PAST = new Date('2026-01-01T00:00:00Z');

interface FixtureRow {
  label: string;
  subs: DerivationSubscriptionEntry[];
  expectedTier: Tier;
  expectedExpiresAt: Date | null;
}

const FIXTURE_MATRIX: FixtureRow[] = [
  {
    label: 'Row 1: Empty array → PUBLIC, null',
    subs: [],
    expectedTier: 'PUBLIC',
    expectedExpiresAt: null,
  },
  {
    label: 'Row 2: Single PRO ACTIVE, future expiresAt → PRO',
    subs: [{ tier: 'PRO', status: 'ACTIVE', expiresAt: FUTURE }],
    expectedTier: 'PRO',
    expectedExpiresAt: FUTURE,
  },
  {
    label: 'Row 3: Single PRO ACTIVE, PAST expiresAt (defensive) → PRO (status=ACTIVE wins)',
    subs: [{ tier: 'PRO', status: 'ACTIVE', expiresAt: PAST }],
    expectedTier: 'PRO',
    expectedExpiresAt: PAST,
  },
  {
    label: 'Row 4: Single PRO CANCELLED, future expiresAt (grace) → PRO',
    subs: [{ tier: 'PRO', status: 'CANCELLED', expiresAt: FUTURE }],
    expectedTier: 'PRO',
    expectedExpiresAt: FUTURE,
  },
  {
    label: 'Row 5: Single PRO CANCELLED, past expiresAt → PUBLIC',
    subs: [{ tier: 'PRO', status: 'CANCELLED', expiresAt: PAST }],
    expectedTier: 'PUBLIC',
    expectedExpiresAt: null,
  },
  {
    label: 'Row 6: Single PRO_MAX ACTIVE → PRO_MAX',
    subs: [{ tier: 'PRO_MAX', status: 'ACTIVE', expiresAt: FUTURE }],
    expectedTier: 'PRO_MAX',
    expectedExpiresAt: FUTURE,
  },
  {
    label: 'Row 7: PRO ACTIVE + PRO_MAX ACTIVE → PRO_MAX wins',
    subs: [
      { tier: 'PRO', status: 'ACTIVE', expiresAt: FUTURE },
      { tier: 'PRO_MAX', status: 'ACTIVE', expiresAt: FUTURE },
    ],
    expectedTier: 'PRO_MAX',
    expectedExpiresAt: FUTURE,
  },
  {
    label: 'Row 8: PRO ACTIVE + PRO_MAX CANCELLED-in-grace → PRO_MAX wins',
    subs: [
      { tier: 'PRO', status: 'ACTIVE', expiresAt: FUTURE },
      { tier: 'PRO_MAX', status: 'CANCELLED', expiresAt: FUTURE },
    ],
    expectedTier: 'PRO_MAX',
    expectedExpiresAt: FUTURE,
  },
  {
    label: 'Row 9: PRO ACTIVE + PRO_MAX CANCELLED-expired → PRO wins',
    subs: [
      { tier: 'PRO', status: 'ACTIVE', expiresAt: FUTURE },
      { tier: 'PRO_MAX', status: 'CANCELLED', expiresAt: PAST },
    ],
    expectedTier: 'PRO',
    expectedExpiresAt: FUTURE,
  },
  {
    label: 'Row 10: PRO CANCELLED-in-grace + PRO_MAX ACTIVE → PRO_MAX wins',
    subs: [
      { tier: 'PRO', status: 'CANCELLED', expiresAt: FUTURE },
      { tier: 'PRO_MAX', status: 'ACTIVE', expiresAt: FUTURE },
    ],
    expectedTier: 'PRO_MAX',
    expectedExpiresAt: FUTURE,
  },
  {
    label: 'Row 11: Both CANCELLED-in-grace → PRO_MAX wins (grace ranks like active)',
    subs: [
      { tier: 'PRO', status: 'CANCELLED', expiresAt: FUTURE },
      { tier: 'PRO_MAX', status: 'CANCELLED', expiresAt: FUTURE },
    ],
    expectedTier: 'PRO_MAX',
    expectedExpiresAt: FUTURE,
  },
  {
    label: 'Row 12: All CANCELLED-expired (sweep should have cleaned) → PUBLIC',
    subs: [
      { tier: 'PRO', status: 'CANCELLED', expiresAt: PAST },
      { tier: 'PRO_MAX', status: 'CANCELLED', expiresAt: PAST },
    ],
    expectedTier: 'PUBLIC',
    expectedExpiresAt: null,
  },
];

beforeAll(async () => {
  await connectTestMongo();
  await UserModel.syncIndexes();
}, 30_000);

afterAll(async () => {
  await disconnectTestMongo();
});

beforeEach(async () => {
  await clearAllCollections();
});

const baseUser = {
  dob: new Date('1995-01-01'),
  declaredState: 'IN-MH',
  kyc: { status: 'NONE' as const },
  blocked: { isBlocked: false },
};

describe('Tier derivation — JS vs MongoDB pipeline contract (12-row matrix)', () => {
  for (const row of FIXTURE_MATRIX) {
    it(`${row.label}: JS implementation matches expected`, () => {
      const tier = deriveCurrentTier(row.subs, NOW);
      const expiresAt = deriveTierExpiresAt(row.subs, NOW);
      expect(tier).toBe(row.expectedTier);
      if (row.expectedExpiresAt === null) {
        expect(expiresAt).toBeNull();
      } else {
        expect(expiresAt).toBeInstanceOf(Date);
        expect(expiresAt?.getTime()).toBe(row.expectedExpiresAt.getTime());
      }
    });

    it(`${row.label}: MongoDB pipeline matches expected (run against in-memory mongo)`, async () => {
      const userId = new Types.ObjectId();
      // Seed: insert user with the row's subscriptions[]; force-set
      // tier/tierExpiresAt to obviously-wrong sentinels so we can
      // confirm the pipeline writes them.
      await UserModel.create({
        _id: userId,
        phone: `+9198000${String(Math.floor(Math.random() * 100_000_000)).padStart(8, '0')}`,
        ...baseUser,
        tier: 'PUBLIC' as const,
        subscriptions: row.subs,
      });

      // Run the pipeline directly via updateOne — same shape the
      // service primitives use.
      await UserModel.updateOne({ _id: userId }, [
        {
          $set: {
            tier: buildDeriveTierPipelineExpr({ nowRef: { $literal: NOW } }),
            tierExpiresAt: buildDeriveTierExpiresAtPipelineExpr({
              nowRef: { $literal: NOW },
            }),
          },
        },
      ]);

      const updated = await UserModel.findById(userId).lean();
      expect(updated?.tier).toBe(row.expectedTier);
      if (row.expectedExpiresAt === null) {
        expect(updated?.tierExpiresAt ?? null).toBeNull();
      } else {
        expect(updated?.tierExpiresAt).toBeInstanceOf(Date);
        expect(updated?.tierExpiresAt?.getTime()).toBe(row.expectedExpiresAt.getTime());
      }
    });
  }

  it('JS and pipeline produce identical (tier, tierExpiresAt) on every row', async () => {
    // Belt-and-braces: even if individual specs above pass, this
    // explicit pairwise comparison makes drift a single test failure
    // rather than 12 scattered ones.
    for (const row of FIXTURE_MATRIX) {
      const userId = new Types.ObjectId();
      await UserModel.create({
        _id: userId,
        phone: `+9198000${String(Math.floor(Math.random() * 100_000_000)).padStart(8, '0')}`,
        ...baseUser,
        tier: 'PUBLIC' as const,
        subscriptions: row.subs,
      });
      await UserModel.updateOne({ _id: userId }, [
        {
          $set: {
            tier: buildDeriveTierPipelineExpr({ nowRef: { $literal: NOW } }),
            tierExpiresAt: buildDeriveTierExpiresAtPipelineExpr({
              nowRef: { $literal: NOW },
            }),
          },
        },
      ]);
      const piped = await UserModel.findById(userId).lean();

      const jsTier = deriveCurrentTier(row.subs, NOW);
      const jsExpiresAt = deriveTierExpiresAt(row.subs, NOW);

      expect(piped?.tier).toBe(jsTier);
      const pipedExpiresMs = piped?.tierExpiresAt?.getTime() ?? null;
      const jsExpiresMs = jsExpiresAt?.getTime() ?? null;
      expect(pipedExpiresMs).toBe(jsExpiresMs);

      await UserModel.deleteOne({ _id: userId });
    }
  });
});
