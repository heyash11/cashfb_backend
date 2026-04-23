import { z } from 'zod';

export const CreateDonationOrderBodySchema = z
  .object({
    amountInRupees: z.coerce.number().int().min(1).max(100_000),
    displayName: z.string().trim().min(1).max(60).optional(),
    isAnonymous: z.coerce.boolean().optional(),
    socialLinks: z
      .object({
        youtube: z.string().url().optional(),
        facebook: z.string().url().optional(),
        instagram: z.string().url().optional(),
      })
      .strict()
      .optional(),
    message: z.string().trim().max(500).optional(),
  })
  .strict();
export type CreateDonationOrderBody = z.infer<typeof CreateDonationOrderBodySchema>;

export const VerifyDonationBodySchema = z
  .object({
    razorpay_order_id: z.string().min(1),
    razorpay_payment_id: z.string().min(1),
    razorpay_signature: z.string().min(1),
  })
  .strict();
export type VerifyDonationBody = z.infer<typeof VerifyDonationBodySchema>;

export const TopDonorsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(50),
  })
  .strict();
export type TopDonorsQuery = z.infer<typeof TopDonorsQuerySchema>;
