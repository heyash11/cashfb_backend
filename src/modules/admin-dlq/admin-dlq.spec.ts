import type { NextFunction, Request, Response } from 'express';
import express from 'express';
import type { Job, Queue } from 'bullmq';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import {
  clearAllCollections,
  connectTestMongo,
  disconnectTestMongo,
} from '../../../test/testing/mongo.js';
import { seedAdminSession } from '../../../test/testing/admin-session-seed.js';
import { AppError } from '../../shared/errors/AppError.js';
import { DlqAuditModel } from '../../shared/models/DlqAudit.model.js';
import { MODELS } from '../../shared/models/index.js';
import type { DlqJobPayload } from '../../workers/dlq.js';
import { AdminDlqService } from './admin-dlq.service.js';
import { createAdminDlqRouter } from './admin-dlq.routes.js';

type AnyModel = { syncIndexes(): Promise<string[]> };

/**
 * Fake BullMQ Queue. Tracks a small in-memory set of jobs keyed by
 * id; only exposes the methods AdminDlqService actually calls
 * (getJobs, getJob, add). The real service under test drives these
 * — the admin-dlq module never touches a real BullMQ connection in
 * tests.
 */
function mkFakeQueue<T>(seed: Array<{ id: string; data: T }> = []) {
  const jobs = new Map<string, { id: string; data: unknown; name: string }>(
    seed.map((s) => [s.id, { id: s.id, data: s.data, name: 'dlq-entry' }]),
  );
  const addSpy = vi.fn(async (_name: string, _data: unknown, opts?: { jobId?: string }) => {
    const id = opts?.jobId ?? `auto-${jobs.size + 1}`;
    const job = { id, data: _data, name: _name };
    jobs.set(id, job);
    return job as unknown as Job;
  });
  return {
    queue: {
      getJobs: vi.fn(async () => [...jobs.values()] as unknown as Job[]),
      getJob: vi.fn(async (id: string) => jobs.get(id) as unknown as Job | undefined),
      add: addSpy,
    } as unknown as Queue<T>,
    addSpy,
  };
}

function makeApp(service: AdminDlqService): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/v1/admin/dlq', createAdminDlqRouter(service));
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction): void => {
    if (res.headersSent) {
      next(err);
      return;
    }
    if (err instanceof AppError) {
      res.status(err.httpStatus).json({
        success: false,
        error: {
          code: err.code,
          message: err.message,
          ...(err.details ? { details: err.details } : {}),
        },
      });
      return;
    }
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL', message: 'Internal server error' },
    });
  });
  return app;
}

beforeAll(async () => {
  await connectTestMongo();
  await Promise.all(Object.values(MODELS).map((m) => (m as unknown as AnyModel).syncIndexes()));
}, 120_000);

afterAll(async () => {
  await disconnectTestMongo();
});

beforeEach(async () => {
  await clearAllCollections();
});

describe('admin-dlq routes', () => {
  const sampleJob = (jobId = 'dlq-1'): { id: string; data: DlqJobPayload } => ({
    id: jobId,
    data: {
      originalQueue: 'cron',
      originalJobId: jobId,
      originalJobName: 'prize-pool:daily',
      originalData: { scheduledFor: '2026-04-23T00:00:00.000Z' },
      failedReason: 'connection refused',
      attemptsMade: 3,
      failedAt: '2026-04-23T00:01:05.000Z',
    },
  });

  it('GET / lists DLQ entries for SUPER_ADMIN; requeued entries hidden by default', async () => {
    const dlq = mkFakeQueue<DlqJobPayload>([sampleJob('dlq-A'), sampleJob('dlq-B')]);
    const src = mkFakeQueue<unknown>();
    const service = new AdminDlqService({
      dlqQueue: dlq.queue,
      resolveQueue: () => src.queue,
    });
    const app = makeApp(service);
    const seed = await seedAdminSession({ role: 'SUPER_ADMIN' });

    // Pre-flag dlq-A as already requeued.
    await DlqAuditModel.create({
      originalJobId: 'dlq-A',
      originalQueue: 'cron',
      originalFailedAt: new Date('2026-04-23T00:01:05.000Z'),
      requeuedAt: new Date(),
      requeuedBy: seed.adminId,
      requeuedByEmail: 'seed-admin@cashfb.test',
      requeuedToJobId: 'requeue-dlq-A-1',
      reason: 'covered by earlier operator action',
    });

    const hidden = await request(app).get('/api/v1/admin/dlq').set('Cookie', seed.cookieHeader);
    expect(hidden.status).toBe(200);
    expect(hidden.body.data.items.length).toBe(1);
    expect(hidden.body.data.items[0].jobId).toBe('dlq-B');
    expect(hidden.body.data.items[0].requeued).toBe(false);

    const all = await request(app)
      .get('/api/v1/admin/dlq?includeRequeued=true')
      .set('Cookie', seed.cookieHeader);
    expect(all.body.data.items.length).toBe(2);
    const byId = new Map(all.body.data.items.map((e: { jobId: string }) => [e.jobId, e]));
    expect((byId.get('dlq-A') as { requeued?: boolean }).requeued).toBe(true);
    expect((byId.get('dlq-B') as { requeued?: boolean }).requeued).toBe(false);
  });

  it('POST /:jobId/requeue preserves DLQ entry, inserts dlq_audit row, enqueues source queue', async () => {
    const dlq = mkFakeQueue<DlqJobPayload>([sampleJob('dlq-live')]);
    const src = mkFakeQueue<unknown>();
    const service = new AdminDlqService({
      dlqQueue: dlq.queue,
      resolveQueue: () => src.queue,
    });
    const app = makeApp(service);
    const seed = await seedAdminSession({ role: 'SUPER_ADMIN' });

    const res = await request(app)
      .post('/api/v1/admin/dlq/dlq-live/requeue')
      .set('Cookie', seed.cookieHeader)
      .set(seed.csrfHeaderName, seed.csrfToken)
      .send({ reason: 'investigated and confirmed safe to retry' });

    expect(res.status).toBe(200);

    // Source queue got a fresh add — original data unchanged.
    expect(src.addSpy).toHaveBeenCalledTimes(1);
    const addArgs = src.addSpy.mock.calls[0];
    expect(addArgs?.[0]).toBe('prize-pool:daily');
    expect((addArgs?.[1] as { scheduledFor?: string }).scheduledFor).toBe(
      '2026-04-23T00:00:00.000Z',
    );

    // dlq_audit row written; contains actor + new job id + reason.
    const audit = await DlqAuditModel.findOne({ originalJobId: 'dlq-live' });
    expect(audit).toBeTruthy();
    expect(audit?.requeuedBy.toHexString()).toBe(seed.adminId);
    expect(audit?.requeuedByEmail).toBe('seed-admin@cashfb.test');
    expect(audit?.reason).toBe('investigated and confirmed safe to retry');
    expect(audit?.requeuedToJobId.startsWith('requeue-dlq-live-')).toBe(true);
  });

  it('double-requeue returns 400 VALIDATION_FAILED; rejects 403 for non-SUPER roles', async () => {
    const dlq = mkFakeQueue<DlqJobPayload>([sampleJob('dlq-dup')]);
    const src = mkFakeQueue<unknown>();
    const service = new AdminDlqService({
      dlqQueue: dlq.queue,
      resolveQueue: () => src.queue,
    });
    const app = makeApp(service);

    const superSeed = await seedAdminSession({ role: 'SUPER_ADMIN' });
    const first = await request(app)
      .post('/api/v1/admin/dlq/dlq-dup/requeue')
      .set('Cookie', superSeed.cookieHeader)
      .set(superSeed.csrfHeaderName, superSeed.csrfToken)
      .send({ reason: 'first retry attempt for stuck cron' });
    expect(first.status).toBe(200);

    const second = await request(app)
      .post('/api/v1/admin/dlq/dlq-dup/requeue')
      .set('Cookie', superSeed.cookieHeader)
      .set(superSeed.csrfHeaderName, superSeed.csrfToken)
      .send({ reason: 'second retry attempt that should be blocked' });
    expect(second.status).toBe(400);
    expect(second.body.error.code).toBe('VALIDATION_FAILED');

    const payment = await seedAdminSession({ role: 'PAYMENT_ADMIN' });
    const wrongRole = await request(app)
      .get('/api/v1/admin/dlq')
      .set('Cookie', payment.cookieHeader);
    expect(wrongRole.status).toBe(403);
  });
});
