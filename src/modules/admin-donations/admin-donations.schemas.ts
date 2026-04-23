import { z } from 'zod';

const StatusSchema = z.enum(['CREATED', 'CAPTURED', 'FAILED', 'REFUNDED']);

/**
 * Query schema for GET /admin/donations. Accepts optional filters;
 * empty query returns most-recent first. Date coercion via Zod so
 * clients can pass ISO strings.
 */
export const AdminDonationsListQuerySchema = z
  .object({
    userId: z
      .string()
      .regex(/^[a-f0-9]{24}$/i, 'userId must be a 24-char hex ObjectId')
      .optional(),
    status: StatusSchema.optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    cursor: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

export type AdminDonationsListQuery = z.infer<typeof AdminDonationsListQuerySchema>;
