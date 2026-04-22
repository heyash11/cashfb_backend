import { describe, expect, it } from 'vitest';
import { REFERRAL_CODE_ALPHABET, generateReferralCode } from './referralCode.js';

describe('generateReferralCode', () => {
  it('defaults to 8 characters', () => {
    expect(generateReferralCode().length).toBe(8);
  });

  it('uses only Crockford base32 characters', () => {
    const code = generateReferralCode(32);
    for (const ch of code) {
      expect(REFERRAL_CODE_ALPHABET.includes(ch)).toBe(true);
    }
  });

  it('excludes I, L, O, U from the alphabet', () => {
    for (const banned of ['I', 'L', 'O', 'U']) {
      expect(REFERRAL_CODE_ALPHABET.includes(banned)).toBe(false);
    }
  });

  it('produces different codes across calls (high entropy)', () => {
    const set = new Set<string>();
    for (let i = 0; i < 100; i++) set.add(generateReferralCode());
    expect(set.size).toBe(100);
  });

  it('respects explicit length', () => {
    expect(generateReferralCode(4).length).toBe(4);
    expect(generateReferralCode(16).length).toBe(16);
  });

  it('rejects non-positive length', () => {
    expect(() => generateReferralCode(0)).toThrow();
    expect(() => generateReferralCode(-1)).toThrow();
  });
});
