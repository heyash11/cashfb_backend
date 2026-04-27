import { describe, expect, it } from 'vitest';
import {
  deriveCurrentTier,
  deriveTierExpiresAt,
  type DerivationSubscriptionEntry,
  type Tier,
} from './_tier.js';

/**
 * Phase 11.5 — `deriveCurrentTier` and `deriveTierExpiresAt`
 * matrix specs.
 *
 * Phase 11.3 originally paired this with a MongoDB pipeline-expression
 * implementation (`buildDeriveTierPipelineExpr`) that wrote the
 * derived value to `User.tier` / `User.tierExpiresAt` for the legacy
 * denormalization. Phase 11.5 deleted those legacy fields and the
 * pipeline-expression mirror; the JS function is now the only
 * implementation and is called explicitly by `/me` for the display-
 * only `currentTier` field.
 *
 * The 12-row canonical matrix below is preserved verbatim — it locks
 * the rule edges (Row 3 = ACTIVE-but-past-expiresAt is still active;
 * Row 11 = both-CANCELLED-in-grace ranks PRO_MAX over PRO).
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

describe('Tier derivation — JS canonical matrix (12 rows)', () => {
  for (const row of FIXTURE_MATRIX) {
    it(row.label, () => {
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
  }
});
