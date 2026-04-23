import { describe, expect, it } from 'vitest';
import { ageInYearsIst, currentFyBoundsIst, dayKeyIst, nowIst } from './date.js';

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

  it('currentFyBoundsIst: Apr–Dec date maps to same-year FY start', () => {
    // 2026-07-15 12:00 IST is clearly inside FY 2026-27.
    const midFy = new Date(Date.UTC(2026, 6, 15, 6, 30)); // 12:00 IST
    const { start, end } = currentFyBoundsIst(midFy);
    // Start: 2026-04-01 00:00 IST = 2026-03-31 18:30 UTC
    expect(start.toISOString()).toBe('2026-03-31T18:30:00.000Z');
    // End: 2027-03-31 23:59:59.999 IST = 2027-03-31 18:29:59.999 UTC
    expect(end.toISOString()).toBe('2027-03-31T18:29:59.999Z');
  });

  it('currentFyBoundsIst: Jan–Mar date maps to previous-year FY start', () => {
    // 2027-02-15 12:00 IST is still FY 2026-27 (started Apr 2026).
    const lateFy = new Date(Date.UTC(2027, 1, 15, 6, 30));
    const { start, end } = currentFyBoundsIst(lateFy);
    expect(start.toISOString()).toBe('2026-03-31T18:30:00.000Z');
    expect(end.toISOString()).toBe('2027-03-31T18:29:59.999Z');
  });
});
