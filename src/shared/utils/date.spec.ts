import { describe, expect, it } from 'vitest';
import { ageInYearsIst, dayKeyIst, nowIst } from './date.js';

describe('date utils', () => {
  it('nowIst returns a dayjs in IST', () => {
    const now = nowIst();
    // IST offset is +5:30 (+330 minutes).
    expect(now.utcOffset()).toBe(330);
  });

  it('dayKeyIst formats as YYYY-MM-DD', () => {
    const key = dayKeyIst(new Date('2026-04-22T12:00:00Z'));
    expect(key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // 2026-04-22 12:00 UTC is 17:30 IST on 2026-04-22.
    expect(key).toBe('2026-04-22');
  });

  it('dayKeyIst boundary: late-evening UTC is next-day IST', () => {
    // 2026-04-22 23:00 UTC is 04:30 IST on 2026-04-23.
    const key = dayKeyIst(new Date('2026-04-22T23:00:00Z'));
    expect(key).toBe('2026-04-23');
  });

  it('ageInYearsIst: someone born 18+ years ago is at least 18', () => {
    const twentyYearsAgo = new Date();
    twentyYearsAgo.setFullYear(twentyYearsAgo.getFullYear() - 20);
    expect(ageInYearsIst(twentyYearsAgo)).toBeGreaterThanOrEqual(19);
  });

  it('ageInYearsIst: pre-birthday this year returns age-1', () => {
    const today = nowIst();
    // Someone whose birthday is tomorrow was born (year-N) and has not
    // yet turned N this year.
    const tomorrow = today.add(1, 'day');
    const dob = new Date(Date.UTC(today.year() - 25, tomorrow.month(), tomorrow.date()));
    expect(ageInYearsIst(dob)).toBe(24);
  });

  it('ageInYearsIst: on birthday today returns the full age', () => {
    const today = nowIst();
    const dob = new Date(Date.UTC(today.year() - 25, today.month(), today.date()));
    expect(ageInYearsIst(dob)).toBe(25);
  });
});
