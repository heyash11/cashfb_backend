import { Types } from 'mongoose';
import { z } from 'zod';

const ObjectIdHex = z
  .string()
  .regex(/^[0-9a-f]{24}$/i, 'Expected a 24-character hex ObjectId')
  .transform((s) => new Types.ObjectId(s));

const SupplierNameEnum = z.enum(['Xoxoday', 'Plum', 'Zaggle', 'Qwikcilver', 'Pine Labs']);

/**
 * `POST /admin/redeem-codes/batches` — the CSV upload is a separate
 * multipart field; this schema validates the JSON metadata that
 * accompanies it.
 */
export const AdminUploadBatchMetaSchema = z
  .object({
    supplierName: SupplierNameEnum,
    supplierInvoiceNumber: z.string().min(1).max(200).optional(),
    supplierInvoiceUrl: z.string().min(1).max(500).optional(),
    denomination: z.coerce.number().int().positive().default(5000),
    notes: z.string().max(1000).optional(),
  })
  .strict();
export type AdminUploadBatchMeta = z.infer<typeof AdminUploadBatchMetaSchema>;

export const AdminPublishBatchBodySchema = z
  .object({
    batchId: ObjectIdHex,
    postId: ObjectIdHex,
    count: z.coerce.number().int().positive().max(10_000),
  })
  .strict();
export type AdminPublishBatchBody = z.infer<typeof AdminPublishBatchBodySchema>;

export const AdminVoidCodeBodySchema = z
  .object({
    reason: z.string().min(1).max(500),
  })
  .strict();
export type AdminVoidCodeBody = z.infer<typeof AdminVoidCodeBodySchema>;

export const AdminListCodesQuerySchema = z
  .object({
    status: z.enum(['AVAILABLE', 'PUBLISHED', 'COPIED', 'CLAIMED', 'EXPIRED', 'VOID']).optional(),
    batchId: ObjectIdHex.optional(),
    postId: ObjectIdHex.optional(),
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();
export type AdminListCodesQuery = z.infer<typeof AdminListCodesQuerySchema>;
