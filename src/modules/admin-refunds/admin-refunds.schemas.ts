import { z } from 'zod';

export const AdminInitiateRefundBodySchema = z
  .object({
    paymentId: z.string().regex(/^[a-f0-9]{24}$/i, 'paymentId must be a 24-char hex ObjectId'),
    reason: z.string().min(1).max(500),
    amountPaise: z.number().int().positive().optional(),
    cancelSubscription: z.boolean().optional(),
  })
  .strict();

export type AdminInitiateRefundBody = z.infer<typeof AdminInitiateRefundBodySchema>;
