import { Types, type FilterQuery } from 'mongoose';
import { ValidationError } from '../../shared/errors/AppError.js';
import { AuditLogModel, type AuditLogAttrs } from '../../shared/models/AuditLog.model.js';

export interface AdminAuditLogsListFilter {
  actorId?: Types.ObjectId;
  resourceKind?: string;
  resourceId?: Types.ObjectId;
  action?: string;
  from?: Date;
  to?: Date;
}

export interface AdminAuditLogsListResult {
  items: AuditLogAttrs[];
  nextCursor?: string;
}

/**
 * Admin reader over the audit_logs collection. Exact-match filters
 * only (prefix matching deferred). Cursor is a base64 of
 * `${createdAt.getTime()}_${_id}` so pagination is keyset rather
 * than skip/limit — important once the collection grows.
 *
 * Reading audit logs is NOT itself audited — GET /audit-logs would
 * write a new audit_logs row which would appear in the next
 * response, creating a feedback loop. Access is still observable
 * via server logs.
 */
export class AdminAuditLogsService {
  async list(
    filter: AdminAuditLogsListFilter,
    cursor: string | undefined,
    limit: number,
  ): Promise<AdminAuditLogsListResult> {
    const q: FilterQuery<AuditLogAttrs> = {};
    if (filter.actorId) q.actorId = filter.actorId;
    if (filter.resourceKind) q['resource.kind'] = filter.resourceKind;
    if (filter.resourceId) q['resource.id'] = filter.resourceId;
    if (filter.action) q.action = filter.action;
    if (filter.from || filter.to) {
      const range: { $gte?: Date; $lte?: Date } = {};
      if (filter.from) range.$gte = filter.from;
      if (filter.to) range.$lte = filter.to;
      q.createdAt = range;
    }

    if (cursor) {
      const { createdAt: cursorCreatedAt, id: cursorId } = decodeCursor(cursor);
      // Paginate by (createdAt desc, _id desc). The next page is
      // everything strictly older than the cursor's tuple.
      const cursorClause: FilterQuery<AuditLogAttrs> = {
        $or: [
          { createdAt: { $lt: cursorCreatedAt } },
          { createdAt: cursorCreatedAt, _id: { $lt: cursorId } },
        ],
      };
      q.$and = [cursorClause, ...(Array.isArray(q.$and) ? q.$and : [])];
    }

    const pageSize = Math.max(1, Math.min(500, limit));
    const rows = await AuditLogModel.find(q)
      .sort({ createdAt: -1, _id: -1 })
      .limit(pageSize + 1)
      .lean<AuditLogAttrs[]>();

    const hasMore = rows.length > pageSize;
    const items = hasMore ? rows.slice(0, pageSize) : rows;
    const result: AdminAuditLogsListResult = { items };
    if (hasMore && items.length > 0) {
      const last = items[items.length - 1]!;
      result.nextCursor = encodeCursor(last.createdAt, last._id);
    }
    return result;
  }
}

function encodeCursor(createdAt: Date, id: Types.ObjectId): string {
  const raw = `${createdAt.getTime()}_${id.toString()}`;
  return Buffer.from(raw, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { createdAt: Date; id: Types.ObjectId } {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const parts = raw.split('_');
    if (parts.length !== 2) throw new Error('bad cursor shape');
    const [tsStr, idStr] = parts as [string, string];
    const ts = Number.parseInt(tsStr, 10);
    if (!Number.isFinite(ts) || !Types.ObjectId.isValid(idStr)) throw new Error('bad cursor data');
    return { createdAt: new Date(ts), id: new Types.ObjectId(idStr) };
  } catch {
    throw new ValidationError('Invalid cursor');
  }
}
