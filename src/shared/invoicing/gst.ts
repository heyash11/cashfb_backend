import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone.js';
import utc from 'dayjs/plugin/utc.js';

dayjs.extend(utc);
dayjs.extend(timezone);

const IST_TZ = 'Asia/Kolkata';

export interface BaseAndGst {
  base: number; // paise, pre-GST
  gst: number; // paise, 18% of base
}

/**
 * Derive pre-GST base + GST amount from a GST-inclusive total
 * (Razorpay charges the inclusive amount). 18% GST rate baked in.
 * `base = round(total * 100 / 118)`. GST = total - base so any
 * rounding residue sits with the tax.
 *
 * Example: total 11800 paise → base 10000, gst 1800.
 */
export function deriveBaseAndGst(totalPaise: number): BaseAndGst {
  const base = Math.round((totalPaise * 100) / 118);
  const gst = totalPaise - base;
  return { base, gst };
}

export interface GstSplit {
  cgst: number;
  sgst: number;
  igst: number;
}

/**
 * Split a GST amount into CGST/SGST (intra-state) or IGST
 * (inter-state). Per PAYMENTS.md §6: intra-state means the
 * merchant's state equals the user's declared state.
 *
 * CGST is `floor(gst / 2)`; SGST absorbs the odd-paisa remainder so
 * the line items always re-sum to `gst`.
 */
export function splitGst(gst: number, intraState: boolean): GstSplit {
  if (!intraState) return { cgst: 0, sgst: 0, igst: gst };
  const cgst = Math.floor(gst / 2);
  const sgst = gst - cgst;
  return { cgst, sgst, igst: 0 };
}

/**
 * Indian financial year key for a given instant, in IST. FY boundary
 * is April 1 → March 31. Returns `'YYYY-YY'` where the second half
 * is the two-digit year after the boundary (e.g. FY 2026-04-01 IST
 * through 2027-03-31 IST → `'2026-27'`).
 */
export function currentFyIST(now: Date): string {
  const ist = dayjs(now).tz(IST_TZ);
  const year = ist.year();
  const month = ist.month(); // 0-indexed; 0 = Jan, 3 = Apr
  const fyStart = month >= 3 ? year : year - 1;
  const fyEnd = fyStart + 1;
  const tail = String(fyEnd).slice(2);
  return `${fyStart}-${tail}`;
}
