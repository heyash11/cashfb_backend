# OPEN_DECISIONS.md

Specific decisions the project owner must close before or during specific development phases. Each item lists which phase it blocks and a recommended default. Do not write code for an affected area until the decision is closed.

When a decision is closed, move it from "Open" to "Closed", record the date and the resolution, and update any dependent doc.

---

## Status legend

- :red_circle: **Open**. Blocks the referenced phase.
- :yellow_circle: **Pending**. Owner has been asked, awaiting answer.
- :green_circle: **Closed**. Decision locked, date + resolution recorded.

---

## 1. PROGA 2025 legal opinion

**Status:** :red_circle: Open
**Blocks:** Phase 6 tournaments, any subscription-gated contest access
**Recommended default:** Feature-flag both paths off. Ship ads-only free contest on day one.

The Promotion and Regulation of Online Gaming Act 2025 (Presidential assent 22 Aug 2025) prohibits "online money games" nationally and removes the "game of skill" defence. Two CashFB features sit near the line:

- (a) BGMI / Free Fire custom-room tournaments with monetary or monetary-equivalent prizes.
- (b) Gift-card contest **when access is gated behind a paid Pro / Pro Max subscription** (subscription = deposit, gift card = in-kind winnings).

The free-entry gift-card contest with ad-funded prizes is defensible as a promotional contest with no consideration.

**Action needed:** Engage a tech-law counsel familiar with PROGA 2025 and any subsequent OGAI guidance. Get a written opinion on whether the subscription-gated contest model is defensible under the current draft rules.

**Blocker impact:** `featureFlags.tournaments` and `featureFlags.proContestAccess` default `false`. Feature flags live in `app_config.featureFlags`. Flipping to `true` requires SUPER_ADMIN and counsel sign-off recorded in `audit_logs`.

---

## 2. Prize pool base rate

**Status:** :red_circle: Open
**Blocks:** Phase 6 prize pool cron (mostly cosmetic; default works)
**Recommended default:** ₹1 per vote (100 paise). Configurable via `app_config.baseRatePerVote`.

With 10,000 daily voters, ~₹10,000 pool next day. Splits as ~₹7,000 gift codes (about 140 codes of ₹50 each) and ~₹3,000 custom-room budget.

**Action needed:** Owner confirms default, or provides an alternative number. Also confirm: is this a permanent default, or should it auto-scale (e.g. `min(votes × 1, ad_revenue × 0.8)`) to avoid paying out more than we earn on a slow day?

---

## 3. Subscription billing cycle

**Status:** :red_circle: Open
**Blocks:** Phase 5 Razorpay plan migration
**Recommended default:** Monthly only at launch. Add yearly in a post-launch iteration if demand emerges.

If yearly is desired, we create a second Razorpay plan per tier:

- Pro Yearly: ₹600 + 18% GST = ₹708
- Pro Max Yearly: ₹1200 + 18% GST = ₹1416

**Action needed:** Owner confirms "monthly only" or specifies yearly price points.

---

## 4. Multiplier semantics (5x / 10x)

**Status:** :red_circle: Open
**Blocks:** Phase 6 prize payout module
**Recommended default:** Option A (multiple codes).

Two possible interpretations:

- **Option A:** Pro winner of a ₹50 gift code receives 5 codes worth ₹250 total. Pro Max receives 10 codes worth ₹500.
- **Option B:** Pro users compete in a separate, larger pool (5x the public pool size).

Architecture supports both via `PrizePoolWinner.multiplier`. UX differs significantly.

**Action needed:** Owner picks A or B. 10-minute call, then locked.

---

## 5. Ad networks at launch

**Status:** :red_circle: Open
**Blocks:** Phase 0 (minor, ads config can be populated later)
**Recommended default:** AdMob day-one, AppLovin or Unity ready as second network.

Architecture is ad-network-agnostic. Backend stores placement key with network + unit IDs. Flutter app plugs in via adapter.

**Action needed:** Owner confirms AdMob. Owner signs up for AdMob publisher account, creates 6 placements:

- `home_top_banner`
- `timer_top_banner`
- `timer_bottom_banner`
- `redeem_code_bottom_banner`
- `custom_room_bottom_banner`
- `result_middle_banner`

Then provide the ad unit IDs (Android + iOS). We enter them in the admin panel `ads_config`.

---

## 6. KYC threshold

**Status:** :red_circle: Open
**Blocks:** Phase 4 (code claim gate)
**Recommended default:** ₹100 (10,000 paise). Any prize claim above ₹100 requires PAN.

Compliance framing: TDS 194BA applies on prize payouts. Having PAN on file before payout is both TDS-practical and a fraud deterrent.

**Action needed:** Owner confirms default, or sets a different threshold. Value lives in `app_config.kycThresholdAmount`.

---

## 7. Refund policy

**Status:** :red_circle: Open
**Blocks:** Phase 5 (refund endpoint + user-facing copy)
**Recommended default:** 7-day no-questions refund on first subscription charge. No refund on renewal charges. Pro-rated refund if cancelled within 24 h of renewal on a support-ticket basis.

**Action needed:** Owner approves or provides revised policy. Legal text goes into `cms_content.TERMS`.

---

## 8. Bot detection vendor

**Status:** :red_circle: Open
**Blocks:** Phase 2 (OTP endpoint hardening)
**Recommended default:** Cloudflare Turnstile (free, privacy-friendly) on OTP request endpoints. Arkose Labs as paid upgrade if fraud volume warrants it.

**Action needed:** Owner approves Turnstile. We add the JS challenge on the signup + login OTP request flows in the Flutter app.

---

## 9. Push notification provider

**Status:** :yellow_circle: Pending (FCM assumed)
**Blocks:** Phase 7 (push broadcast)
**Recommended default:** FCM via Firebase Admin SDK.

**Action needed:** Owner creates Firebase project, downloads service account JSON, uploads to SSM. For iOS (later): upload APNs key to FCM console.

---

## 10. Google Play gift card supplier

**Status:** :red_circle: Open
**Blocks:** Phase 4 (first code batch upload)
**Recommended default:** Xoxoday or Qwikcilver, based on whichever gives better pricing in INR.

Options (all Google-authorised B2B resellers in India):

- **Xoxoday**. Bengaluru-based, wide SKU range, API available.
- **Plum (by QwikCilver)**. Same parent company, slightly different SKU.
- **Zaggle**. Enterprise-focused.
- **Qwikcilver** (Pine Labs). Oldest in the space, strong relationships.
- **Pine Labs**. Same parent as Qwikcilver.

**Action needed:** Owner engages with 2 to 3 suppliers, gets pricing quotes, completes KYB, opens account. Supplier invoices must be saved per batch in `redeem_code_batches.supplierInvoiceUrl`.

**Do not bulk-buy from consumer marketplaces (Amazon, Flipkart).** Google's resale terms prohibit this and may void the codes.

---

## 11. Grievance Officer

**Status:** :red_circle: Open
**Blocks:** Prod launch (IT Rules 2021 requires published Grievance Officer contact)
**Recommended default:** Owner appoints themselves or a senior team member.

Required per IT Rules 2021 and DPDP Act 2023. Must be:

- Named individual (not a role inbox).
- Indian resident.
- Contactable via email and phone.
- Published in-app and on marketing site.

**Action needed:** Owner provides:

- Full name
- Designation
- Email
- Phone
- Postal address

Goes into `cms_content.GRIEVANCE` and surfaces at `GET /cms/grievance`.

---

## 12. Merchant GSTIN and state

**Status:** :red_circle: Open
**Blocks:** Phase 5 (GST invoice generation)
**Recommended default:** None. Must be provided.

Invoice generation on every `subscription.charged` needs:

- Merchant legal name (registered entity name).
- Merchant GSTIN (15-character).
- Merchant registered state (ISO 3166-2:IN code, e.g. `IN-MH` for Maharashtra).
- Merchant registered address.

Place of supply is the user's declared state. Intra-state uses CGST + SGST split. Inter-state uses IGST.

**Action needed:** Owner provides registration details. If entity is not yet registered for GST, start the process immediately. If annual turnover exceeds ₹20 lakh (or ₹40 lakh in some states), registration is mandatory.

---

## 13. DPDP erasure schema design

**Status:** :red_circle: Open
**Blocks:** DPDP compliance work (post-MVP phase; does NOT block Phase 1).
**Recommended default:** Add `deletedAt: Date` and `anonymizedAt: Date` to `users`. 30-day grace via a daily `user-anonymize-sweep` cron. On anonymisation, overwrite phone/email/displayName/avatarUrl/socialLinks/PAN ciphertext with nulls or hashed tombstones; keep `_id` and `createdAt` for referential integrity.

The `DELETE /me` endpoint (SECURITY.md §10) and the DPDP Act erasure requirement need a durable schema story. Not plumbed in Phase 1 to avoid speculative fields. Three sub-questions the owner should close:

1. Does the same `deletedAt`/`anonymizedAt` pair belong on `donations`? Donor name, displayName, and socialLinks are PII even after the user is gone.
2. For `audit_logs`, `coin_transactions`, `prize_pool_winners` (which reference `userId`): erase the user's presence, or retain for integrity/regulatory purposes? Counsel should weigh in, especially for prize records (TDS 194BA retention).
3. Is 30-day grace acceptable under DPDP, or does the owner prefer 7 days / immediate erasure with a confirmation step?

**Action needed:** Owner confirms the field set, grace window, and which collections receive erasure fields. Once closed, add the fields to the relevant models and wire the sweep cron in Phase 7 or a dedicated compliance phase.

---

## Template for closing an item

When a decision closes, replace its block with:

```
## N. <Title>

**Status:** :green_circle: Closed on YYYY-MM-DD
**Resolution:** <one-paragraph description of the final decision>
**Implementer:** <who rolled it out>
**Linked PR:** #NNN
```

Keep the original wording below under `### Original question` for future reference.
