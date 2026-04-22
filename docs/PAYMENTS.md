# PAYMENTS.md

Everything about money flowing through CashFB. Razorpay for both donations and subscriptions. GST invoicing is ours, not Razorpay's. Refunds go back through Razorpay.

---

## 1. Razorpay setup

Accounts and keys:

- **Test key** for local + staging. Live key for prod only.
- Store `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` in AWS Secrets Manager. Rotate on any admin departure.
- Webhook secret: `RAZORPAY_WEBHOOK_SECRET`. Distinct from key secret. Configured on Razorpay dashboard per environment.

Node SDK:

```ts
import Razorpay from 'razorpay';
export const rzp = new Razorpay({
  key_id: env.RAZORPAY_KEY_ID,
  key_secret: env.RAZORPAY_KEY_SECRET,
});
```

---

## 2. Plans (one-time setup per environment)

Run `pnpm migrate:plans` once per environment. Script creates the Pro and Pro Max plans and writes the returned plan IDs to `app_config.razorpayPlanIds`.

```ts
// scripts/migrate-razorpay-plans.ts
await rzp.plans.create({
  period: 'monthly',
  interval: 1,
  item: {
    name: 'CashFB Pro',
    amount: 5900, // ₹59 incl. 18% GST, in paise
    currency: 'INR',
    description: 'Monthly Pro tier (incl. 18% GST)',
  },
  notes: { tier: 'PRO', sac: '998439' },
});

await rzp.plans.create({
  period: 'monthly',
  interval: 1,
  item: {
    name: 'CashFB Pro Max',
    amount: 11800, // ₹118 incl. 18% GST
    currency: 'INR',
    description: 'Monthly Pro Max tier (incl. 18% GST)',
  },
  notes: { tier: 'PRO_MAX', sac: '998439' },
});
```

**Plans are immutable.** To change pricing, create a new plan and migrate users.

---

## 3. Donation flow

### Create order

Client (app or website) hits `POST /donations/create-order`:

```ts
const order = await rzp.orders.create({
  amount: amountInRupees * 100,
  currency: 'INR',
  receipt: `don_${Date.now()}_${donorUserId ?? 'anon'}`,
  notes: { donorUserId, purpose: 'donation' },
});

await Donations.create({
  userId: donorUserId ?? null,
  displayName,
  isAnonymous,
  amount: order.amount,
  razorpayOrderId: order.id,
  status: 'CREATED',
  message,
  socialLinks,
  ipAddress: req.ip,
});

return { orderId: order.id, amount: order.amount, keyId: env.RAZORPAY_KEY_ID };
```

### Client checkout

Flutter app opens Razorpay Checkout with `orderId`. On success, client calls `POST /donations/verify` with `{razorpay_order_id, razorpay_payment_id, razorpay_signature}`.

### Verify (tentative)

Server verifies signature locally. Marks donation as tentatively captured. **Does not trust this alone.**

```ts
const generated = crypto
  .createHmac('sha256', env.RAZORPAY_KEY_SECRET)
  .update(`${orderId}|${paymentId}`)
  .digest('hex');
if (generated !== signature) throw new BadRequestError('INVALID_SIGNATURE');
```

### Webhook (authoritative)

Razorpay sends `payment.captured` or `order.paid`. See §5.

---

## 4. Subscription flow

### Create subscription

Client hits `POST /subscriptions/create`:

```ts
const planId = appConfig.razorpayPlanIds[tier];
const sub = await rzp.subscriptions.create({
  plan_id: planId,
  total_count: 360, // 30 years of monthly cycles
  customer_notify: 1,
  notes: { internal_user_id: String(userId) },
});

await Subscriptions.create({
  userId,
  tier,
  razorpaySubscriptionId: sub.id,
  razorpayPlanId: planId,
  status: 'CREATED',
  baseAmount: bases[tier],
  gstAmount: gsts[tier],
  totalAmount: totals[tier],
});

return { subscriptionId: sub.id };
```

### Client checkout

Flutter app opens Razorpay Checkout in subscription mode with `subscriptionId`. User completes payment authorisation via card/UPI/netbanking.

### Verify (tentative)

Post-authenticate, client calls `POST /subscriptions/verify` with `{razorpay_payment_id, razorpay_subscription_id, razorpay_signature}`.

**Note the different signature format for subscriptions:**

```ts
const generated = crypto
  .createHmac('sha256', env.RAZORPAY_KEY_SECRET)
  .update(`${razorpay_payment_id}|${razorpay_subscription_id}`)
  .digest('hex');
```

The order of IDs is `payment|subscription`, not `order|payment`.

### Lifecycle events

After first authentication:

- `subscription.authenticated`. User authorised the mandate.
- `subscription.activated`. Mandate active.
- `subscription.charged`. Fires every billing cycle. Generate invoice here.
- `subscription.halted`. Mandate failed retry cycle. Tier downgrade.
- `subscription.paused` / `subscription.resumed`. User-initiated pause.
- `subscription.cancelled`. Cancelled by user or admin.
- `subscription.completed`. `paid_count` reached `total_count`.

### Cancel

```ts
await rzp.subscriptions.cancel(subId, { cancel_at_cycle_end: atCycleEnd ? 1 : 0 });
```

---

## 5. Webhook handler

Webhook endpoint: `POST /webhooks/razorpay`. Raw body. HMAC-SHA256 signature. Idempotent.

### Mount raw body parser BEFORE express.json

```ts
// In src/server.ts, BEFORE app.use(express.json(...))
app.post(
  '/api/v1/webhooks/razorpay',
  express.raw({ type: 'application/json' }),
  razorpayWebhookHandler,
);
```

### Handler

```ts
// src/modules/webhooks/razorpay.controller.ts
import Razorpay from 'razorpay';

export async function razorpayWebhookHandler(req, res) {
  const sig = req.header('X-Razorpay-Signature');
  const eventId = req.header('X-Razorpay-Event-Id');
  const raw = req.body as Buffer;

  if (!sig || !eventId) return res.status(400).send('missing headers');

  const ok = Razorpay.validateWebhookSignature(
    raw.toString('utf8'),
    sig,
    env.RAZORPAY_WEBHOOK_SECRET,
  );
  if (!ok) return res.status(400).send('invalid signature');

  // Idempotency
  const existed = await WebhookEvents.findOne({ eventId }).lean();
  if (existed?.status === 'DONE') return res.status(200).send('duplicate');

  const event = JSON.parse(raw.toString('utf8'));

  await WebhookEvents.updateOne(
    { eventId },
    {
      $setOnInsert: { source: 'RAZORPAY', eventId, eventType: event.event, receivedAt: new Date() },
      $set: { payload: event, status: 'PROCESSING' },
    },
    { upsert: true },
  );

  try {
    switch (event.event) {
      case 'payment.captured':
      case 'order.paid':
        await donationsService.onCaptured(event.payload);
        break;
      case 'subscription.authenticated':
        await subsService.onAuthenticated(event.payload);
        break;
      case 'subscription.activated':
        await subsService.onActivated(event.payload);
        break;
      case 'subscription.charged':
        await subsService.onCharged(event.payload);
        break;
      case 'subscription.completed':
        await subsService.onCompleted(event.payload);
        break;
      case 'subscription.cancelled':
        await subsService.onCancelled(event.payload);
        break;
      case 'subscription.halted':
        await subsService.onHalted(event.payload);
        break;
      case 'subscription.paused':
        await subsService.onPaused(event.payload);
        break;
      case 'subscription.resumed':
        await subsService.onResumed(event.payload);
        break;
      case 'subscription.pending':
        await subsService.onPending(event.payload);
        break;
      case 'refund.processed':
        await refundsService.onProcessed(event.payload);
        break;
      default:
        /* log and ignore */ break;
    }
    await WebhookEvents.updateOne({ eventId }, { status: 'DONE', processedAt: new Date() });
    return res.status(200).send('ok');
  } catch (err) {
    await WebhookEvents.updateOne(
      { eventId },
      { $inc: { attempts: 1 }, $set: { status: 'FAILED', lastError: String(err) } },
    );
    return res.status(500).send('retry');
  }
}
```

Razorpay retries non-2xx responses with exponential backoff for up to 24 hours. Always return **200** on duplicates, not 4xx.

---

## 6. GST invoicing

Razorpay does not issue GST-compliant tax invoices to your customers on subscription charges. You do.

### On every `subscription.charged`

1. Derive base and GST from total:

   ```ts
   const total = payload.payment.entity.amount; // paise
   const base = Math.round((total * 100) / 118);
   const gst = total - base;
   ```

2. Decide intra-state vs inter-state based on merchant state and user's declared state:

   ```ts
   const merchantState = env.MERCHANT_STATE_CODE; // 'IN-MH'
   const userState = user.declaredState; // 'IN-KA'
   const isIntraState = merchantState === userState;
   const cgst = isIntraState ? Math.floor(gst / 2) : 0;
   const sgst = isIntraState ? gst - cgst : 0;
   const igst = isIntraState ? 0 : gst;
   ```

3. Generate sequential invoice number per FY using the `counters` collection:

   ```ts
   const fy = currentFyIST(); // e.g. '2026-27'
   const counter = await Counters.findOneAndUpdate(
     { key: `invoice:${fy}` },
     { $inc: { value: 1 } },
     { upsert: true, new: true },
   );
   const invoiceNumber = `CF/${fy}/${String(counter.value).padStart(6, '0')}`;
   ```

4. Render PDF via `pdf-lib`. Include:
   - Merchant legal name, address, GSTIN
   - Customer name + phone (or name + GSTIN if B2B)
   - Invoice number + date
   - Description: `CashFB Pro subscription, monthly`
   - SAC code: **998439** (Other on-line contents n.e.c.)
   - Base, CGST/SGST or IGST, total
   - Place of supply (user's state)
   - Note: "This is a computer-generated invoice."

5. Upload to S3 under `invoices/{userId}/{invoiceNumber}.pdf`. Save key on `subscription_payments.invoicePdfUrl`.

6. Email the user via SES with the PDF attached.

### SAC code

**998439**. "Other on-line contents n.e.c." Suitable for a digital subscription.

### Place of supply

User's declared state (`users.declaredState`). Capture at signup.

---

## 7. Refunds

```ts
const refund = await rzp.payments.refund(paymentId, {
  amount: partialPaise, // omit for full refund
  speed: 'normal',
  receipt: `ref_${Date.now()}`,
  notes: { reason: 'user_request' },
});
```

**Subscription refunds do NOT auto-cancel the subscription.** You must also call:

```ts
await rzp.subscriptions.cancel(subId, { cancel_at_cycle_end: 0 });
```

Refund webhook (`refund.processed`) updates `subscription_payments.status` and decrements MTD revenue in reports.

---

## 8. Idempotency patterns

- **Razorpay order ID** is unique per order. Use it as the natural key on `donations` (`razorpayOrderId` unique index).
- **Razorpay payment ID** is unique per successful charge. Unique index on `subscription_payments.razorpayPaymentId`.
- **Razorpay subscription ID** unique on `subscriptions`.
- **Webhook event ID** (`X-Razorpay-Event-Id`) unique on `webhook_events`.

If any of these arrive twice, the second write is a no-op.

---

## 9. Testing

### Local

- Razorpay test mode keys.
- Webhook: use `ngrok` to expose local server, configure a test-mode webhook endpoint.
- Test cards from [Razorpay docs](https://razorpay.com/docs/payments/payments/test-card-details/).

### Staging

- Separate Razorpay test account.
- Webhook endpoint: `https://staging.cashfb.com/api/v1/webhooks/razorpay`.

### Prod

- Live keys in AWS Secrets Manager.
- Webhook on prod domain. Verify end-to-end with a ₹1 test subscription before announcing.

### Test scenarios

- Donation captured. Top-donor cache refresh triggered.
- Subscription first charge. Tier upgraded, invoice generated.
- Subscription halted. Tier downgraded to PUBLIC.
- Subscription cancelled at cycle end. Tier persists until `currentEnd`.
- Refund. Payment marked `REFUNDED`, revenue report updated.
- Duplicate webhook (same event ID). 200 OK, no state change.
- Invalid signature. 400, no state change.

---

## 10. Customer-facing copy

- Subscription confirmation email: mention tier, next billing date, `currentEnd`, cancellation policy, invoice attachment.
- Refund confirmation email: original amount, refund amount, expected settlement date (Razorpay says 5 to 7 business days).
- Failed charge notification: tier will be downgraded at `currentEnd` unless retry succeeds.

All copy lives in `src/shared/email/templates/` as Handlebars templates.

---

## 11. Compliance footnotes

- GST 18% is baked into the displayed price. Invoices show the breakdown.
- Merchant GSTIN must be registered before going live.
- Tax-invoice numbering must be sequential per FY with no gaps. Never delete an invoice row; mark `voidedReason` instead.
- TDS 194BA (30%) applies to prize payouts, not subscription revenue. See `docs/SECURITY.md` §compliance.
- Retain invoice records for 8 years (GST Act s.36).
