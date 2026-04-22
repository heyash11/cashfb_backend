import dayjs, { type Dayjs } from 'dayjs';
import timezone from 'dayjs/plugin/timezone.js';
import utc from 'dayjs/plugin/utc.js';

dayjs.extend(utc);
dayjs.extend(timezone);

export const IST_TZ = 'Asia/Kolkata';

/**
 * Current moment in IST. Prefer this over `new Date()` in business
 * logic so dayKeys, scheduling, and cron all agree on the same
 * timezone (CONVENTIONS.md §Dates).
 */
export function nowIst(): Dayjs {
  return dayjs().tz(IST_TZ);
}

/**
 * Canonical YYYY-MM-DD string in IST. Use for `votes.dayKey`,
 * `posts.dayKey`, `prize_pools.dayKey`, and every per-day row.
 */
export function dayKeyIst(d: Date | Dayjs = nowIst()): string {
  return dayjs(d).tz(IST_TZ).format('YYYY-MM-DD');
}

/**
 * Age in completed years against "now in IST". Matches signup's
 * 18+ gate: someone born exactly 18 years ago *today* returns 18,
 * someone whose birthday has not arrived yet this year returns
 * (thisYear - dobYear - 1).
 */
export function ageInYearsIst(dob: Date): number {
  const today = nowIst();
  const born = dayjs(dob).tz(IST_TZ);

  let age = today.year() - born.year();
  const hasHadBirthdayThisYear =
    today.month() > born.month() || (today.month() === born.month() && today.date() >= born.date());
  if (!hasHadBirthdayThisYear) {
    age -= 1;
  }
  return age;
}
