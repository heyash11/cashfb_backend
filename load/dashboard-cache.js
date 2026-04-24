import http from 'k6/http';
import { check } from 'k6';

/**
 * Phase 9 Chunk 5 — admin dashboard cache-hit latency.
 *
 * Shape: 100 rps constant over 60s hitting GET /admin/dashboard/
 * metrics. The endpoint is Redis-cached with a 60s TTL, so after
 * the first request every subsequent call should be a cache hit
 * (p95 < 20ms).
 *
 * Setup: admin login against a pre-seeded admin (created via
 * `pnpm admin:create` before running). Session cookie + CSRF
 * captured once, reused across the 6000 scrapes.
 */

const TARGET = __ENV.K6_TARGET || 'http://localhost:4000';
const ADMIN_EMAIL = __ENV.K6_ADMIN_EMAIL || 'loadtest@cashfb.test';
const ADMIN_PASSWORD = __ENV.K6_ADMIN_PASSWORD || 'LoadTest12345!';

export const options = {
  scenarios: {
    cache: {
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
    'http_req_duration{name:dashboard}': ['p(95)<20'],
    checks: ['rate>0.999'],
    http_req_failed: ['rate<0.005'],
  },
};

export function setup() {
  const loginRes = http.post(
    `${TARGET}/api/v1/admin/auth/login`,
    JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  if (loginRes.status !== 200) {
    throw new Error(
      `dashboard-cache setup: admin login failed (status ${loginRes.status}). ` +
        `Run 'pnpm admin:create' with K6_ADMIN_EMAIL / K6_ADMIN_PASSWORD first. ` +
        `Body: ${loginRes.body}`,
    );
  }
  const body = loginRes.json();
  const csrfToken = body.data.csrfToken;

  // Extract session cookie from Set-Cookie for re-use.
  const setCookie = loginRes.headers['Set-Cookie'] || loginRes.headers['set-cookie'] || '';
  const sessionMatch = /cfb_admin_session=([^;]+)/.exec(setCookie);
  if (!sessionMatch) {
    throw new Error(`dashboard-cache setup: no admin session cookie in login response`);
  }
  return { cookie: `cfb_admin_session=${sessionMatch[1]}`, csrfToken };
}

export default function (data) {
  const res = http.get(`${TARGET}/api/v1/admin/dashboard/metrics`, {
    headers: {
      Cookie: data.cookie,
      'X-CSRF-Token': data.csrfToken,
    },
    tags: { name: 'dashboard' },
  });
  check(res, { 'dashboard 200': (r) => r.status === 200 });
}
