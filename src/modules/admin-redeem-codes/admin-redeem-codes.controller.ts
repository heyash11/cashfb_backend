import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { ValidationError } from '../../shared/errors/AppError.js';
import type { AuditCaptureContext } from '../../shared/middleware/audit-log.js';
import type {
  AdminRedeemCodeService,
  ListCodesFilter,
  UploadBatchInput,
} from '../redeem-codes/redeem-codes.admin.service.js';
import {
  AdminListCodesQuerySchema,
  AdminPublishBatchBodySchema,
  AdminUploadBatchMetaSchema,
  AdminVoidCodeBodySchema,
} from './admin-redeem-codes.schemas.js';

/**
 * HTTP thin layer over AdminRedeemCodeService. One audited write
 * surface (upload/publish/void), one non-audited list, and one
 * streaming export that pipes a Mongoose cursor directly to the
 * response for memory-safe full-history dumps.
 */
export class AdminRedeemCodesController {
  constructor(private readonly service: AdminRedeemCodeService) {}

  upload = async (req: Request): Promise<AuditCaptureContext> => {
    if (!req.file) {
      throw new ValidationError('CSV file is required under the "file" field');
    }
    const meta = AdminUploadBatchMetaSchema.parse(req.body);
    const actorId = new Types.ObjectId(req.admin!.adminId);
    const input: UploadBatchInput = {
      csvBuffer: req.file.buffer,
      supplierName: meta.supplierName,
      denomination: meta.denomination,
    };
    if (meta.supplierInvoiceNumber !== undefined) {
      input.supplierInvoiceNumber = meta.supplierInvoiceNumber;
    }
    if (meta.supplierInvoiceUrl !== undefined) {
      input.supplierInvoiceUrl = meta.supplierInvoiceUrl;
    }
    if (meta.notes !== undefined) input.notes = meta.notes;

    const result = await this.service.uploadBatch(input, actorId);
    return {
      before: null,
      after: {
        batchId: result.batchId.toHexString(),
        inserted: result.inserted,
        skippedCount: result.skipped.length,
      },
      resourceKind: 'RedeemCodeBatch',
      resourceId: result.batchId,
    };
  };

  publish = async (req: Request): Promise<AuditCaptureContext> => {
    const body = AdminPublishBatchBodySchema.parse(req.body);
    const actorId = new Types.ObjectId(req.admin!.adminId);
    const result = await this.service.publishBatchToPost(
      { batchId: body.batchId, postId: body.postId, count: body.count },
      actorId,
    );
    return {
      before: { batchId: body.batchId.toHexString(), postId: body.postId.toHexString() },
      after: result,
      resourceKind: 'RedeemCodeBatch',
      resourceId: body.batchId,
    };
  };

  void = async (req: Request): Promise<AuditCaptureContext> => {
    const codeId = parseObjectId(req.params.id, 'id');
    const body = AdminVoidCodeBodySchema.parse(req.body);
    const actorId = new Types.ObjectId(req.admin!.adminId);
    const before = await this.service.getForAudit(codeId);
    await this.service.voidCode(codeId, body.reason, actorId);
    const after = await this.service.getForAudit(codeId);
    return { before, after, resourceKind: 'RedeemCode', resourceId: codeId };
  };

  list = async (req: Request, res: Response): Promise<void> => {
    const q = AdminListCodesQuerySchema.parse(req.query);
    const filter: ListCodesFilter = {};
    if (q.status) filter.status = q.status;
    if (q.batchId) filter.batchId = q.batchId;
    if (q.postId) filter.postId = q.postId;
    const result = await this.service.listCodes(filter, q.cursor, q.limit);
    res.json({ success: true, data: result });
  };

  export = (req: Request, res: Response): void => {
    const q = AdminListCodesQuerySchema.parse(req.query);
    const filter: ListCodesFilter = {};
    if (q.status) filter.status = q.status;
    if (q.batchId) filter.batchId = q.batchId;
    if (q.postId) filter.postId = q.postId;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="redeem-codes.csv"');
    const stream = this.service.auditExport(filter);
    stream.pipe(res);
    stream.on('error', (err) => {
      if (!res.headersSent) {
        res.status(500).end();
      } else {
        res.destroy(err);
      }
    });
  };
}

function parseObjectId(raw: unknown, field: string): Types.ObjectId {
  if (typeof raw !== 'string' || !Types.ObjectId.isValid(raw)) {
    throw new ValidationError(`Invalid ${field}`);
  }
  return new Types.ObjectId(raw);
}
