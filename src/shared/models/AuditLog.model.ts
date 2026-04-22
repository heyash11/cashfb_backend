import { Schema, model, Types, type HydratedDocument, type Model } from 'mongoose';
import { baseSchemaOptions } from './_base.js';

export interface AuditLogResource {
  kind?: string;
  id?: Types.ObjectId;
}

export interface AuditLogAttrs {
  _id: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
  actorId: Types.ObjectId;
  actorEmail?: string;
  action: string;
  resource?: AuditLogResource;
  /** Snapshot of the resource before the admin action; shape varies per kind. */
  before?: Record<string, unknown>;
  /** Snapshot of the resource after the admin action; shape varies per kind. */
  after?: Record<string, unknown>;
  ip?: string;
  userAgent?: string;
}

const AuditLogSchema = new Schema(
  {
    actorId: { type: Types.ObjectId, ref: 'AdminUser', required: true, index: true },
    actorEmail: String,
    action: { type: String, required: true, index: true }, // e.g. 'POST_CREATE', 'SUBSCRIPTION_CANCEL'
    resource: {
      kind: String,
      id: { type: Types.ObjectId },
    },
    before: Schema.Types.Mixed,
    after: Schema.Types.Mixed,
    ip: String,
    userAgent: String,
  },
  baseSchemaOptions,
);

AuditLogSchema.index({ createdAt: -1 }); // chronological sweep + retention cutoff
AuditLogSchema.index({ actorId: 1, createdAt: -1 }); // per-actor audit
AuditLogSchema.index({ 'resource.kind': 1, 'resource.id': 1 }); // per-resource audit

export type AuditLogDoc = HydratedDocument<AuditLogAttrs>;
export const AuditLogModel: Model<AuditLogAttrs> = model<AuditLogAttrs>(
  'AuditLog',
  AuditLogSchema,
  'audit_logs',
);
export { AuditLogSchema };
