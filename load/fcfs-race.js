import http from 'k6/http';
import { Counter } from 'k6/metrics';
import { check } from 'k6';
import { seedUsers } from './_setup/seed-users.js';

/**
 * Phase 9 Chunk 5 — FCFS race load test.
 *
 * Shape: 1 redeem code, 100 users hit POST /redeem-codes/:id/copy
 * at the same moment. The code is the atomic FCFS primitive —
 * exactly 1 winner, 99 losers. This is the canonical test that
 * the atomic findOneAndUpdate + unique-index guard both work
 * under real contention.
 *
 * Setup is more involved than other scripts: it must seed a post,
 * mark it "completed" by all 100 users (prereq for claim), upload a
 * 1-code batch, publish to the post, and hand back the code ID.
 * The setup does not use the admin API — it pokes Mongo directly
 * via a dev-only endpoint is NOT available, so this script must
 * EITHER run against a pre-seeded state OR target staging with
 * admin credentials.
 *
 * For Phase 9 local dev, the simplest path is a helper `pnpm
 * load:seed-fcfs` script (scripts/load-seed-fcfs.ts) that admin-
 * creates the code via mongosh-equivalent Node setup, then this
 * k6 script is given the codeId + postId via env vars:
 *   K6_FCFS_CODE_ID=<codeId> K6_FCFS_POST_ID=<postId> k6 run ...
 *
 * If the env vars are absent, the setup fails fast with a clear
 * message — do NOT silently degrade.
 */

const TARGET = __ENV.K6_TARGET || 'http://localhost:4000';
const CODE_ID = __ENV.K6_FCFS_CODE_ID;
const POST_ID = __ENV.K6_FCFS_POST_ID;
const VU_COUNT = 100;

const fcfsSuccess = new Counter('fcfs_success');
const fcfsConflict = new Counter('fcfs_conflict');
const fcfsOther = new Counter('fcfs_other');

export const options = {
  scenarios: {
    race: {
      executor: 'per-vu-iterations',
      vus: VU_COUNT,
      iterations: 1,
      maxDuration: '20s',
      startTime: '2s',
    },
  },
  thresholds: {
    fcfs_success: ['count==1'],
    fcfs_conflict: ['count==99'],
    fcfs_other: ['count==0'],
    // Deliberately NOT gating on http_req_failed — 99 of 100 claim
    // requests return 409 CODE_TAKEN (the expected loser outcome),
    // which counts as "failed" in that metric. Custom counters
    // above are the source of truth for this test.
  },
};

export function setup() {
  if (!CODE_ID || !POST_ID) {
    throw new Error(
      'fcfs-race: K6_FCFS_CODE_ID and K6_FCFS_POST_ID env vars required. ' +
        'Run `pnpm load:seed-fcfs` first to seed the code + post and capture the IDs.',
    );
  }
  const users = seedUsers(VU_COUNT);

  // Mark the post completed for each user so the claim gate passes.
  // Hits /posts/:id/complete directly on the real HTTP surface.
  for (const user of users) {
    const res = http.post(
      `${TARGET}/api/v1/posts/${POST_ID}/complete`,
      JSON.stringify({}),
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${user.access}`,
        },
      },
    );
    check(res, {
      'post-complete 200 or already-completed': (r) => r.status === 200 || r.status === 409,
    });
  }
  return { users };
}

export default function (data) {
  const user = data.users[(__VU - 1) % data.users.length];

  const res = http.post(
    `${TARGET}/api/v1/redeem-codes/${CODE_ID}/copy`,
    JSON.stringify({}),
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${user.access}`,
      },
      tags: { name: 'fcfs_copy' },
    },
  );

  if (res.status === 200) {
    fcfsSuccess.add(1);
  } else if (res.status === 409) {
    fcfsConflict.add(1);
  } else {
    fcfsOther.add(1);
  }
}
