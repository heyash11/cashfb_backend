import {
  Schema,
  model,
  Types,
  type HydratedDocument,
  type InferSchemaType,
  type Model,
} from 'mongoose';
import { baseSchemaOptions } from './_base.js';

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

export type AuditLogAttrs = InferSchemaType<typeof AuditLogSchema>;
export type AuditLogDoc = HydratedDocument<AuditLogAttrs>;
export const AuditLogModel: Model<AuditLogAttrs> = model<AuditLogAttrs>(
  'AuditLog',
  AuditLogSchema,
  'audit_logs',
);
export { AuditLogSchema };
