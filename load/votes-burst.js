import http from 'k6/http';
import { check } from 'k6';
import { seedUsers } from './_setup/seed-users.js';

/**
 * Phase 9 Chunk 5 — votes-burst load test.
 *
 * Shape: 100 synthetic users each vote once within a 10s hot
 * window. Simulates a "new post went live + 100 users with app
 * open burst-vote" scenario.
 *
 * Thresholds fail the run if breached; see load/README.md for
 * posture on local vs staging (local runs may flake — rerun; do
 * NOT loosen thresholds).
 */

const TARGET = __ENV.K6_TARGET || 'http://localhost:4000';
const VU_COUNT = 100;

export const options = {
  scenarios: {
    burst: {
      executor: 'per-vu-iterations',
      vus: VU_COUNT,
      iterations: 1,
      maxDuration: '30s',
      startTime: '2s',
    },
  },
  thresholds: {
    'http_req_duration{name:vote}': ['p(95)<500'],
    checks: ['rate>0.99'],
    http_req_failed: ['rate<0.01'],
  },
};

export function setup() {
  const users = seedUsers(VU_COUNT);
  return { users };
}

export default function (data) {
  const user = data.users[(__VU - 1) % data.users.length];
  const target = `load-post-${__VU}`;

  const res = http.post(
    `${TARGET}/api/v1/votes`,
    JSON.stringify({ target }),
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${user.access}`,
      },
      tags: { name: 'vote' },
    },
  );

  check(res, {
    'vote response is 2xx or documented 4xx': (r) =>
      r.status === 200 || r.status === 400 || r.status === 402 || r.status === 409,
  });
}
