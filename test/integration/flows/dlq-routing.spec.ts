import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Job, Worker } from 'bullmq';
import { vi } from 'vitest';
import { getQueue } from '../../../src/config/queues.js';
import { env } from '../../../src/config/env.js';
import { routeFailedToDlq, type DlqJobPayload } from '../../../src/workers/dlq.js';
import { connectHarness, disconnectHarness, resetFullState } from './_harness.js';

/**
 * Integration — DLQ routing listener against real BullMQ + Redis.
 * Simulates a worker 'failed' event with attemptsMade >= attempts
 * and asserts the DLQ queue receives the payload with the expected
 * shape.
 *
 * Regression guard for Phase 7: exhausted jobs must land in the
 * shared DLQ queue with full forensic context (originalQueue,
 * originalData, failedReason, attemptsMade) so Chunk 3a's admin
 * /dlq list + requeue endpoints can drive remediation.
 */
beforeAll(async () => {
  await connectHarness();
}, 30_000);

afterAll(async () => {
  await disconnectHarness();
});

beforeEach(async () => {
  await resetFullState();
  // Drain the DLQ queue between specs so prior test residue
  // doesn't leak into the count assertions.
  const dlq = getQueue<DlqJobPayload>(env.BULL_DLQ_NAME);
  await dlq.drain(true);
});

describe('[integration] DLQ routing', () => {
  it('exhausted job lands in the BullMQ dlq queue with originalQueue + originalData', async () => {
    // Fake Worker sufficient for routeFailedToDlq: exposes .on()
    // and .name, captures the listener.
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const fakeWorker = {
      name: 'cron',
      on: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
        listeners.set(event, fn);
        return fakeWorker;
      }),
    } as unknown as Worker;

    routeFailedToDlq(fakeWorker);
    expect(listeners.get('failed')).toBeTypeOf('function');

    const failedListener = listeners.get('failed')!;
    const fakeJob = {
      id: 'test-job-id-999',
      name: 'prize-pool:daily',
      data: { scheduledFor: '2026-04-24T00:00:00+05:30' },
      opts: { attempts: 3 },
      attemptsMade: 3,
    } as unknown as Job;
    const err = new Error('synthetic failure for DLQ routing test');
    err.stack = 'Error: synthetic\n    at test';
    failedListener(fakeJob, err);

    // Allow BullMQ add() to complete. routeFailedToDlq fires a
    // promise chain we can't await directly, so poll briefly.
    const dlq = getQueue<DlqJobPayload>(env.BULL_DLQ_NAME);
    let jobs: Job<DlqJobPayload>[] = [];
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      jobs = await dlq.getJobs(['waiting', 'active', 'delayed'], 0, 10, false);
      if (jobs.length > 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    expect(jobs.length).toBe(1);
    const payload = jobs[0]?.data;
    expect(payload?.originalQueue).toBe('cron');
    expect(payload?.originalJobId).toBe('test-job-id-999');
    expect(payload?.originalJobName).toBe('prize-pool:daily');
    expect(payload?.failedReason).toBe('synthetic failure for DLQ routing test');
    expect(payload?.attemptsMade).toBe(3);
    expect(typeof payload?.failedAt).toBe('string');
  });

  it('non-terminal failure (attemptsMade < attempts) does NOT route to DLQ', async () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const fakeWorker = {
      name: 'cron',
      on: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
        listeners.set(event, fn);
        return fakeWorker;
      }),
    } as unknown as Worker;

    routeFailedToDlq(fakeWorker);
    const failedListener = listeners.get('failed')!;

    const nonTerminalJob = {
      id: 'retry-me',
      name: 'invoice-generate',
      data: { paymentId: 'x' },
      opts: { attempts: 5 },
      attemptsMade: 2, // 2 of 5 — BullMQ will retry
    } as unknown as Job;
    failedListener(nonTerminalJob, new Error('transient'));

    await new Promise((r) => setTimeout(r, 200));
    const dlq = getQueue<DlqJobPayload>(env.BULL_DLQ_NAME);
    const jobs = await dlq.getJobs(['waiting', 'active', 'delayed'], 0, 10, false);
    expect(jobs.length).toBe(0);
  });
});
