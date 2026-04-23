import { z } from 'zod';

const ObjectIdHex = z.string().regex(/^[a-f0-9]{24}$/i, '24-char hex ObjectId');

export const AdminAuditLogsListQuerySchema = z
  .object({
    actorId: ObjectIdHex.optional(),
    resourceKind: z.string().min(1).max(100).optional(),
    resourceId: ObjectIdHex.optional(),
    action: z.string().min(1).max(100).optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    cursor: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  })
  .strict();

export type AdminAuditLogsListQuery = z.infer<typeof AdminAuditLogsListQuerySchema>;
