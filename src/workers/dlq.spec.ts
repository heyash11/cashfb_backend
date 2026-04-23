import { describe, expect, it, vi } from 'vitest';
import type { Job, Worker } from 'bullmq';
import { routeFailedToDlq } from './dlq.js';

// The routeFailedToDlq listener interacts with `getQueue(DLQ)` — a
// module-lazy Queue that opens Redis. To keep this unit test
// self-contained we mock `../config/queues.js` at import time.
vi.mock('../config/queues.js', async () => {
  const addSpy = vi.fn().mockResolvedValue(undefined);
  return {
    getQueue: vi.fn(() => ({ add: addSpy })),
    // Re-expose the spy so the test can assert on it.
    __addSpy: addSpy,
  };
});

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
type QueuesModule = typeof import('../config/queues.js') & {
  __addSpy: ReturnType<typeof vi.fn>;
};

async function getAddSpy(): Promise<ReturnType<typeof vi.fn>> {
  const mod = (await import('../config/queues.js')) as QueuesModule;
  return mod.__addSpy;
}

function mkWorker(name = 'invoice'): {
  worker: Worker;
  emit: (job: Job | undefined, err: Error) => void;
} {
  const listeners: Array<(j: Job | undefined, e: Error) => void> = [];
  const worker = {
    name,
    on: (event: string, cb: (j: Job | undefined, e: Error) => void) => {
      if (event === 'failed') listeners.push(cb);
    },
  } as unknown as Worker;
  return {
    worker,
    emit: (j, e) => listeners.forEach((cb) => cb(j, e)),
  };
}

function mkJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job_abc',
    name: 'invoice-generate',
    data: { paymentId: 'pay_123' },
    attemptsMade: 3,
    opts: { attempts: 3 },
    ...overrides,
  } as unknown as Job;
}

describe('routeFailedToDlq', () => {
  it('routes a job to the DLQ when attemptsMade >= attempts (terminal failure)', async () => {
    const addSpy = await getAddSpy();
    addSpy.mockClear();

    const { worker, emit } = mkWorker('invoice');
    routeFailedToDlq(worker);
    emit(mkJob({ attemptsMade: 3, opts: { attempts: 3 } } as Partial<Job>), new Error('boom'));

    // Listener is sync; the `.add(...).catch(...)` chain resolves
    // microtask-eagerly. Flush with Promise.resolve().
    await Promise.resolve();
    await Promise.resolve();

    expect(addSpy).toHaveBeenCalledTimes(1);
    const [jobName, payload] = addSpy.mock.calls[0] ?? [];
    expect(jobName).toBe('dlq-entry');
    expect(payload).toMatchObject({
      originalQueue: 'invoice',
      originalJobId: 'job_abc',
      originalJobName: 'invoice-generate',
      originalData: { paymentId: 'pay_123' },
      failedReason: 'boom',
      attemptsMade: 3,
    });
    expect(typeof (payload as { failedAt: string }).failedAt).toBe('string');
  });

  it('does NOT route when attemptsMade < attempts (still retrying)', async () => {
    const addSpy = await getAddSpy();
    addSpy.mockClear();

    const { worker, emit } = mkWorker('webhook-retry');
    routeFailedToDlq(worker);
    emit(mkJob({ attemptsMade: 2, opts: { attempts: 7 } } as Partial<Job>), new Error('transient'));

    await Promise.resolve();
    expect(addSpy).not.toHaveBeenCalled();
  });

  it('gracefully handles undefined job (BullMQ edge case)', async () => {
    const addSpy = await getAddSpy();
    addSpy.mockClear();

    const { worker, emit } = mkWorker();
    routeFailedToDlq(worker);
    emit(undefined, new Error('ghost failure'));

    await Promise.resolve();
    expect(addSpy).not.toHaveBeenCalled();
  });
});
