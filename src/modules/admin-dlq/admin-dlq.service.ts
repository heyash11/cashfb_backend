import type { Queue } from 'bullmq';
import type { Types } from 'mongoose';
import { env } from '../../config/env.js';
import { getQueue } from '../../config/queues.js';
import { NotFoundError, ValidationError } from '../../shared/errors/AppError.js';
import { DlqAuditModel, type DlqAuditAttrs } from '../../shared/models/DlqAudit.model.js';
import type { DlqJobPayload } from '../../workers/dlq.js';

export interface AdminDlqListEntry {
  jobId: string;
  originalQueue: string;
  originalJobName: string;
  originalData: unknown;
  failedReason: string;
  attemptsMade: number;
  failedAt: string;
  requeued: boolean;
  requeuedAt?: Date;
  requeuedBy?: Types.ObjectId;
  requeuedByEmail?: string;
  requeuedToJobId?: string;
}

export interface AdminDlqListResult {
  items: AdminDlqListEntry[];
}

export interface RequeueInput {
  jobId: string;
  reason: string;
  actorId: Types.ObjectId;
  actorEmail: string;
}

export interface RequeueResult {
  originalJobId: string;
  originalQueue: string;
  requeuedToJobId: string;
  auditId: Types.ObjectId;
}

export interface AdminDlqServiceDeps {
  /** Injected for tests; prod uses the shared BullMQ queue registry. */
  dlqQueue?: Queue<DlqJobPayload>;
  /** Resolver for source queues — test overrides let us skip BullMQ. */
  resolveQueue?: (name: string) => Queue;
}

/**
 * Admin DLQ ops. Reads BullMQ's `dlq` queue and joins against the
 * `dlq_audit` Mongo sidecar to determine which entries have already
 * been requeued. A requeue action NEVER deletes the DLQ job — the
 * entry is preserved as a forensic record; the `dlq_audit` row is
 * the operator's action trail.
 */
export class AdminDlqService {
  private readonly dlqQueue: Queue<DlqJobPayload>;
  private readonly resolveQueue: (name: string) => Queue;

  constructor(deps: AdminDlqServiceDeps = {}) {
    this.dlqQueue = deps.dlqQueue ?? getQueue<DlqJobPayload>(env.BULL_DLQ_NAME);
    this.resolveQueue = deps.resolveQueue ?? ((name: string) => getQueue(name));
  }

  async list(opts: { includeRequeued: boolean; limit: number }): Promise<AdminDlqListResult> {
    // BullMQ stores DLQ entries as `waiting` (no worker drains them).
    // `failed` covers any that errored during the DLQ insert itself.
    const jobs = await this.dlqQueue.getJobs(
      ['waiting', 'failed', 'delayed'],
      0,
      opts.limit - 1,
      false,
    );

    const jobIds = jobs.map((j) => j.id).filter((id): id is string => Boolean(id));
    const auditRows = await DlqAuditModel.find({ originalJobId: { $in: jobIds } }).lean();
    const auditByJobId = new Map<string, DlqAuditAttrs>();
    for (const r of auditRows) auditByJobId.set(r.originalJobId, r);

    const items: AdminDlqListEntry[] = [];
    for (const job of jobs) {
      const id = job.id;
      if (!id) continue;
      const payload = job.data;
      const audit = auditByJobId.get(id);
      const requeued = Boolean(audit);
      if (!opts.includeRequeued && requeued) continue;
      const entry: AdminDlqListEntry = {
        jobId: id,
        originalQueue: payload.originalQueue,
        originalJobName: payload.originalJobName,
        originalData: payload.originalData,
        failedReason: payload.failedReason,
        attemptsMade: payload.attemptsMade,
        failedAt: payload.failedAt,
        requeued,
      };
      if (audit) {
        entry.requeuedAt = audit.requeuedAt;
        entry.requeuedBy = audit.requeuedBy;
        entry.requeuedByEmail = audit.requeuedByEmail;
        entry.requeuedToJobId = audit.requeuedToJobId;
      }
      items.push(entry);
    }
    return { items };
  }

  async requeue(input: RequeueInput): Promise<RequeueResult> {
    const dlqJob = await this.dlqQueue.getJob(input.jobId);
    if (!dlqJob) throw new NotFoundError('DLQ job not found');

    const existing = await DlqAuditModel.findOne({ originalJobId: input.jobId });
    if (existing) {
      throw new ValidationError('DLQ job already requeued', {
        originalJobId: input.jobId,
        requeuedToJobId: existing.requeuedToJobId,
      });
    }

    const payload = dlqJob.data;
    const sourceQueue = this.resolveQueue(payload.originalQueue);
    const requeuedToJobId = `requeue-${payload.originalJobId}-${Date.now()}`;
    await sourceQueue.add(payload.originalJobName, payload.originalData, {
      jobId: requeuedToJobId,
    });

    const auditRow = await DlqAuditModel.create({
      originalJobId: payload.originalJobId,
      originalQueue: payload.originalQueue,
      originalData: asRecord(payload.originalData),
      originalFailedAt: new Date(payload.failedAt),
      requeuedAt: new Date(),
      requeuedBy: input.actorId,
      requeuedByEmail: input.actorEmail,
      requeuedToJobId,
      reason: input.reason,
    });

    return {
      originalJobId: payload.originalJobId,
      originalQueue: payload.originalQueue,
      requeuedToJobId,
      auditId: auditRow._id,
    };
  }
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return undefined;
  return v as Record<string, unknown>;
}
