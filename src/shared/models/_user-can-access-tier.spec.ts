import { describe, expect, it } from 'vitest';
import { userCanAccessTier, type DerivationSubscriptionEntry, type Tier } from './_tier.js';

/**
 * Phase 11.4 — `userCanAccessTier` matrix. The strict subscription
 * model: a user has access to a tier section if and only if their
 * `subscriptions[]` contains an active entry for that tier
 * (PUBLIC always accessible without a subscription).
 *
 * "Active for access" reuses Phase 11.3's `isActiveForDerivation`
 * predicate (single source of truth):
 *   active = status === 'ACTIVE'
 *          OR (status === 'CANCELLED' AND expiresAt > now)
 *
 * The 12-row matrix below mirrors the derivation contract spec
 * shape — same edge cases, different question (access vs current
 * tier).
 */

const NOW = new Date('2026-04-27T12:00:00Z');
const FUTURE = new Date('2027-01-01T00:00:00Z');
const PAST = new Date('2026-01-01T00:00:00Z');

interface Row {
  label: string;
  subs: DerivationSubscriptionEntry[];
  requested: Tier;
  expected: boolean;
}

const MATRIX: Row[] = [
  { label: 'No subs + PUBLIC → true', subs: [], requested: 'PUBLIC', expected: true },
  { label: 'No subs + PRO → false', subs: [], requested: 'PRO', expected: false },
  { label: 'No subs + PRO_MAX → false', subs: [], requested: 'PRO_MAX', expected: false },
  {
    label: '[PRO ACTIVE] + PRO → true',
    subs: [{ tier: 'PRO', status: 'ACTIVE', expiresAt: FUTURE }],
    requested: 'PRO',
    expected: true,
  },
  {
    label: '[PRO ACTIVE] + PRO_MAX → false (no hierarchical inclusion)',
    subs: [{ tier: 'PRO', status: 'ACTIVE', expiresAt: FUTURE }],
    requested: 'PRO_MAX',
    expected: false,
  },
  {
    label: '[PRO_MAX ACTIVE] + PRO → false (KEY FLIP — strict, NOT hierarchical)',
    subs: [{ tier: 'PRO_MAX', status: 'ACTIVE', expiresAt: FUTURE }],
    requested: 'PRO',
    expected: false,
  },
  {
    label: '[PRO_MAX ACTIVE] + PRO_MAX → true',
    subs: [{ tier: 'PRO_MAX', status: 'ACTIVE', expiresAt: FUTURE }],
    requested: 'PRO_MAX',
    expected: true,
  },
  {
    label: '[PRO ACTIVE, PRO_MAX ACTIVE] + PRO → true (stackable)',
    subs: [
      { tier: 'PRO', status: 'ACTIVE', expiresAt: FUTURE },
      { tier: 'PRO_MAX', status: 'ACTIVE', expiresAt: FUTURE },
    ],
    requested: 'PRO',
    expected: true,
  },
  {
    label: '[PRO ACTIVE, PRO_MAX ACTIVE] + PRO_MAX → true (stackable)',
    subs: [
      { tier: 'PRO', status: 'ACTIVE', expiresAt: FUTURE },
      { tier: 'PRO_MAX', status: 'ACTIVE', expiresAt: FUTURE },
    ],
    requested: 'PRO_MAX',
    expected: true,
  },
  {
    label: '[PRO CANCELLED-grace] + PRO → true (grace counts as active)',
    subs: [{ tier: 'PRO', status: 'CANCELLED', expiresAt: FUTURE }],
    requested: 'PRO',
    expected: true,
  },
  {
    label: '[PRO CANCELLED-expired] + PRO → false',
    subs: [{ tier: 'PRO', status: 'CANCELLED', expiresAt: PAST }],
    requested: 'PRO',
    expected: false,
  },
  {
    label:
      '[PRO_MAX CANCELLED-grace] + PRO → false (still strict; PRO_MAX grace does NOT grant PRO)',
    subs: [{ tier: 'PRO_MAX', status: 'CANCELLED', expiresAt: FUTURE }],
    requested: 'PRO',
    expected: false,
  },
  {
    label:
      '[PRO ACTIVE, PRO_MAX CANCELLED-expired] + PRO_MAX → false (PRO_MAX entry no longer active)',
    subs: [
      { tier: 'PRO', status: 'ACTIVE', expiresAt: FUTURE },
      { tier: 'PRO_MAX', status: 'CANCELLED', expiresAt: PAST },
    ],
    requested: 'PRO_MAX',
    expected: false,
  },
];

describe('userCanAccessTier — strict subscription matrix (Phase 11.4)', () => {
  for (const row of MATRIX) {
    it(row.label, () => {
      expect(userCanAccessTier(row.subs, row.requested, NOW)).toBe(row.expected);
    });
  }

  it('PUBLIC tier is always accessible regardless of subscriptions[]', () => {
    expect(userCanAccessTier([], 'PUBLIC', NOW)).toBe(true);
    expect(
      userCanAccessTier([{ tier: 'PRO', status: 'CANCELLED', expiresAt: PAST }], 'PUBLIC', NOW),
    ).toBe(true);
  });

  it('EXPIRED status NEVER counts (defense-in-depth for delayed sweep)', () => {
    expect(
      userCanAccessTier([{ tier: 'PRO', status: 'EXPIRED', expiresAt: FUTURE }], 'PRO', NOW),
    ).toBe(false);
  });
});
