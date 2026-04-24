import http from 'k6/http';
import crypto from 'k6/crypto';
import { check } from 'k6';

/**
 * Phase 9 Chunk 5 — Razorpay webhook-ingest load test.
 *
 * Shape: 100 rps for 60s against POST /api/v1/webhooks/razorpay.
 * Each request carries a uniquely-generated `razorpayOrderId` and
 * `eventId`, plus a valid HMAC-SHA256 signature against the
 * configured webhook secret.
 *
 * Because each order/event is unique, every event is "first-seen"
 * and hits the full middleware chain (raw-body parser → HMAC
 * validate → idempotency insert on webhook_events → dispatch).
 * The handler will look up a Donation row by order_id; unknown
 * order → the service no-ops without error. So the "load" we're
 * measuring is the raw middleware chain + idempotency check + the
 * no-op handler branch.
 *
 * Threshold: p95 < 500ms, error rate < 1%.
 */

const TARGET = __ENV.K6_TARGET || 'http://localhost:4000';
const SECRET = __ENV.K6_WEBHOOK_SECRET || 'dev-webhook-secret-placeholder';

export const options = {
  scenarios: {
    ingest: {
      executor: 'constant-arrival-rate',
      rate: 100,
      timeUnit: '1s',
      duration: '60s',
      preAllocatedVUs: 50,
      maxVUs: 200,
      startTime: '2s',
    },
  },
  thresholds: {
    'http_req_duration{name:webhook}': ['p(95)<500'],
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],
  },
};

export default function () {
  const orderId = `order_k6_${__VU}_${__ITER}_${Date.now()}`;
  const paymentId = `pay_k6_${__VU}_${__ITER}_${Date.now()}`;
  const eventId = `evt_k6_${__VU}_${__ITER}_${Date.now()}`;

  const body = {
    event: 'payment.captured',
    payload: {
      payment: {
        entity: {
          id: paymentId,
          order_id: orderId,
          amount: 10_000,
          currency: 'INR',
          status: 'captured',
          notes: {},
        },
      },
    },
  };
  const raw = JSON.stringify(body);
  const signature = crypto.hmac('sha256', SECRET, raw, 'hex');

  const res = http.post(`${TARGET}/api/v1/webhooks/razorpay`, raw, {
    headers: {
      'Content-Type': 'application/json',
      'x-razorpay-signature': signature,
      'x-razorpay-event-id': eventId,
    },
    tags: { name: 'webhook' },
  });

  check(res, {
    'webhook 200 (no matching donation → no-op is a success response)': (r) => r.status === 200,
  });
}
