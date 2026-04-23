import { describe, expect, it } from 'vitest';
import { computeTds194BA } from './tds.js';

describe('computeTds194BA', () => {
  it('computes flat 30% on round amounts', () => {
    expect(computeTds194BA(1000)).toBe(300); // ₹10 → ₹3 TDS
    expect(computeTds194BA(100_000)).toBe(30_000); // ₹1,000 → ₹300
    expect(computeTds194BA(5_000_000)).toBe(1_500_000); // ₹50,000 → ₹15,000
  });

  it('rounds odd-paisa inputs half-up', () => {
    // 100 × 0.3 = 30 exact.
    expect(computeTds194BA(100)).toBe(30);
    // 101 × 0.3 = 30.3 → 30
    expect(computeTds194BA(101)).toBe(30);
    // 105 × 0.3 = 31.5 → 32 (Math.round banker-free)
    expect(computeTds194BA(105)).toBe(32);
    // Zero/negative/NaN → 0 (defensive; statutory zero).
    expect(computeTds194BA(0)).toBe(0);
    expect(computeTds194BA(-100)).toBe(0);
    expect(computeTds194BA(Number.NaN)).toBe(0);
  });
});
