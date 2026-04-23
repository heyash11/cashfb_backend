import { describe, expect, it } from 'vitest';
import { currentFyIST, deriveBaseAndGst, splitGst } from './gst.js';

describe('deriveBaseAndGst', () => {
  it('splits 11800 paise total into base 10000 + gst 1800 (Pro Max)', () => {
    expect(deriveBaseAndGst(11800)).toEqual({ base: 10000, gst: 1800 });
  });

  it('splits 5900 paise total into base 5000 + gst 900 (Pro)', () => {
    expect(deriveBaseAndGst(5900)).toEqual({ base: 5000, gst: 900 });
  });

  it('base + gst always re-sums to the input total (residue absorbed by gst)', () => {
    for (const total of [1, 99, 118, 999, 1234, 11_800, 99_999]) {
      const { base, gst } = deriveBaseAndGst(total);
      expect(base + gst).toBe(total);
    }
  });
});

describe('splitGst', () => {
  it('intra-state splits 1800 into CGST 900 + SGST 900, IGST 0', () => {
    expect(splitGst(1800, true)).toEqual({ cgst: 900, sgst: 900, igst: 0 });
  });

  it('intra-state odd-paisa residue goes to SGST so components re-sum to gst', () => {
    const s = splitGst(901, true);
    expect(s).toEqual({ cgst: 450, sgst: 451, igst: 0 });
    expect(s.cgst + s.sgst + s.igst).toBe(901);
  });

  it('inter-state places the whole gst on IGST', () => {
    expect(splitGst(1800, false)).toEqual({ cgst: 0, sgst: 0, igst: 1800 });
  });
});

describe('currentFyIST', () => {
  it('returns "2026-27" for April 1 2026 IST', () => {
    // April 1 00:00 IST = March 31 18:30 UTC.
    expect(currentFyIST(new Date('2026-03-31T18:30:00Z'))).toBe('2026-27');
  });

  it('returns "2025-26" for March 31 2026 IST (still prior FY)', () => {
    // March 31 23:59:59 IST = same day 18:29:59 UTC.
    expect(currentFyIST(new Date('2026-03-31T18:29:59Z'))).toBe('2025-26');
  });

  it('crosses the FY boundary cleanly around April 1 IST', () => {
    expect(currentFyIST(new Date('2026-04-15T12:00:00Z'))).toBe('2026-27');
    expect(currentFyIST(new Date('2027-03-15T12:00:00Z'))).toBe('2026-27');
    expect(currentFyIST(new Date('2027-04-15T12:00:00Z'))).toBe('2027-28');
  });
});
