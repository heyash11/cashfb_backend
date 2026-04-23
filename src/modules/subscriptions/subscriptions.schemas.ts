import { Types } from 'mongoose';
import { z } from 'zod';

const ObjectIdHex = z
  .string()
  .regex(/^[0-9a-f]{24}$/i, 'Expected a 24-character hex ObjectId')
  .transform((s) => new Types.ObjectId(s));

export const CreateSubscriptionBodySchema = z
  .object({
    tier: z.enum(['PRO', 'PRO_MAX']),
  })
  .strict();
export type CreateSubscriptionBody = z.infer<typeof CreateSubscriptionBodySchema>;

export const VerifySubscriptionBodySchema = z
  .object({
    razorpay_payment_id: z.string().min(1),
    razorpay_subscription_id: z.string().min(1),
    razorpay_signature: z.string().min(1),
  })
  .strict();
export type VerifySubscriptionBody = z.infer<typeof VerifySubscriptionBodySchema>;

export const CancelSubscriptionBodySchema = z
  .object({
    atCycleEnd: z.coerce.boolean(),
  })
  .strict();
export type CancelSubscriptionBody = z.infer<typeof CancelSubscriptionBodySchema>;

export const SubscriptionIdParamsSchema = z
  .object({
    id: ObjectIdHex,
  })
  .strict();
export type SubscriptionIdParams = z.infer<typeof SubscriptionIdParamsSchema>;
