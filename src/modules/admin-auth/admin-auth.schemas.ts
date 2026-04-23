import { z } from 'zod';

export const AdminLoginBodySchema = z
  .object({
    email: z.string().email(),
    password: z.string().min(1).max(200),
    /** Provided when admin.twoFactor.enabled. Phase 8 ships 2FA
     *  infrastructure only — enforcement deferred per §8a. */
    totpCode: z
      .string()
      .regex(/^[0-9]{6}$/)
      .optional(),
  })
  .strict();
export type AdminLoginBody = z.infer<typeof AdminLoginBodySchema>;
