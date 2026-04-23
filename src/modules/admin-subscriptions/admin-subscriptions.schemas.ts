import { z } from 'zod';

const StatusSchema = z.enum([
  'CREATED',
  'AUTHENTICATED',
  'ACTIVE',
  'PENDING',
  'HALTED',
  'CANCELLED',
  'COMPLETED',
  'PAUSED',
]);
const TierSchema = z.enum(['PRO', 'PRO_MAX']);

export const AdminSubscriptionsListQuerySchema = z
  .object({
    tier: TierSchema.optional(),
    status: StatusSchema.optional(),
    cursor: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

export const AdminSubscriptionsRevenueQuerySchema = z
  .object({
    from: z.coerce.date(),
    to: z.coerce.date(),
  })
  .strict()
  .refine((d) => d.from <= d.to, { message: 'from must be <= to', path: ['from'] });

export type AdminSubscriptionsListQuery = z.infer<typeof AdminSubscriptionsListQuerySchema>;
export type AdminSubscriptionsRevenueQuery = z.infer<typeof AdminSubscriptionsRevenueQuerySchema>;
