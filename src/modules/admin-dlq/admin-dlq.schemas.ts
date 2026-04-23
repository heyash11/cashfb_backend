import { z } from 'zod';

export const AdminDlqListQuerySchema = z
  .object({
    includeRequeued: z.coerce.boolean().default(false),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  })
  .strict();

export const AdminDlqRequeueBodySchema = z
  .object({
    reason: z.string().min(10).max(500),
  })
  .strict();

export type AdminDlqListQuery = z.infer<typeof AdminDlqListQuerySchema>;
export type AdminDlqRequeueBody = z.infer<typeof AdminDlqRequeueBodySchema>;
