import { Schema, model, Types, type HydratedDocument, type Model } from 'mongoose';
import { baseSchemaOptions } from './_base.js';

/**
 * Forensic record of every DLQ requeue. The BullMQ DLQ entry itself
 * is preserved untouched (Phase 7 routing sets removeOnComplete +
 * removeOnFail false); this sidecar collection captures the admin
 * action that retried it. A requeued job inserts a row here at
 * retry time; subsequent GET /admin/dlq LEFT-JOINs this collection
 * to hide already-requeued items by default.
 */
export interface DlqAuditAttrs {
  _id: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
  /** BullMQ jobId from the DLQ queue. Unique by index — one requeue per DLQ entry. */
  originalJobId: string;
  /** Source queue the job originally ran on (QUEUES.CRON / INVOICE / WEBHOOK_RETRY). */
  originalQueue: string;
  /** Snapshot of the failed job's data payload. Mixed so we accept
   *  whatever shape a given worker type emits. */
  originalData?: Record<string, unknown>;
  /** When the job moved into the DLQ (set by the DLQ-routing worker). */
  originalFailedAt: Date;
  /** When the operator clicked "requeue". */
  requeuedAt: Date;
  /** AdminUser._id of the operator. */
  requeuedBy: Types.ObjectId;
  /** AdminUser.email at requeue time — denormalised for audit stability. */
  requeuedByEmail: string;
  /** New BullMQ jobId created by the requeue. */
  requeuedToJobId: string;
  /** Operator-supplied explanation, validated at the Zod layer. */
  reason: string;
}

const DlqAuditSchema = new Schema(
  {
    originalJobId: { type: String, required: true, unique: true },
    originalQueue: { type: String, required: true, index: true },
    originalData: { type: Schema.Types.Mixed },
    originalFailedAt: { type: Date, required: true },
    requeuedAt: { type: Date, required: true, index: true },
    requeuedBy: { type: Types.ObjectId, ref: 'AdminUser', required: true },
    requeuedByEmail: { type: String, required: true },
    requeuedToJobId: { type: String, required: true },
    reason: { type: String, required: true, maxlength: 500 },
  },
  baseSchemaOptions,
);

export type DlqAuditDoc = HydratedDocument<DlqAuditAttrs>;
export const DlqAuditModel: Model<DlqAuditAttrs> = model<DlqAuditAttrs>(
  'DlqAudit',
  DlqAuditSchema,
  'dlq_audit',
);
export { DlqAuditSchema };
