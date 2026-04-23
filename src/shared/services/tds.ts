/**
 * India §194BA TDS on online gaming winnings. Flat 30% withholding
 * on `finalAmount` — the post-multiplier prize value. No threshold,
 * no slab; every winnings row is taxed at the same rate.
 *
 * CashFB policy (per docs/SECURITY.md §TDS 194BA): we record the
 * TDS on `PrizePoolWinner.tdsDeducted` for accounting. The gift-code
 * face value is NOT modified; TDS is absorbed by the company, not
 * deducted from the winner. This is the "no gross-up" decision
 * from Phase 8 §8j.
 *
 * Pure — no I/O. If the statutory rate ever changes, bump this
 * function (e.g. `computeTds194BA_v2`) rather than mutating in
 * place, so historical audit rows stay reproducible from input.
 */
const TDS_RATE = 0.3;

export function computeTds194BA(finalAmountPaise: number): number {
  if (!Number.isFinite(finalAmountPaise) || finalAmountPaise <= 0) return 0;
  // Round, not floor — the statutory obligation is to deduct 30%.
  // Floor would under-collect by ~1 paisa on odd inputs.
  return Math.round(finalAmountPaise * TDS_RATE);
}
