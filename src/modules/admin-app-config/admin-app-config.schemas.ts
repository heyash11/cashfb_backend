import { z } from 'zod';

const TimeOfDay = z.string().regex(/^\d{2}:\d{2}$/, 'must be HH:MM');
const TierSchema = z.enum(['PUBLIC', 'PRO', 'PRO_MAX']);

/**
 * PATCH body — every field optional. Controller only $set's supplied
 * keys; unspecified fields are left alone. Strict mode rejects
 * unknown keys so typos don't silently no-op.
 */
export const AdminAppConfigPatchBodySchema = z
  .object({
    baseRatePerVote: z.number().int().nonnegative().optional(),
    signupBonusCoins: z.number().int().nonnegative().optional(),
    coinsPerPost: z.number().int().nonnegative().optional(),
    coinsPerVote: z.number().int().nonnegative().optional(),
    giftCodeDenomination: z.number().int().positive().optional(),
    proMultiplier: z.number().int().positive().optional(),
    proMaxMultiplier: z.number().int().positive().optional(),
    voteWindowIst: z
      .object({
        start: TimeOfDay,
        end: TimeOfDay,
      })
      .strict()
      .optional(),
    blockedStates: z.array(z.string().regex(/^IN-[A-Z]{2}$/)).optional(),
    kycThresholdAmount: z.number().int().nonnegative().optional(),
    ageMin: z.number().int().min(13).max(99).optional(),
    maintenanceMode: z.boolean().optional(),
    featureFlags: z.record(z.string(), z.unknown()).optional(),
    razorpayPlanIds: z
      .object({
        PRO: z.string().min(1).optional(),
        PRO_MAX: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    adminIpAllowlist: z.array(z.string().min(1)).optional(),
  })
  .strict();

export type AdminAppConfigPatchBody = z.infer<typeof AdminAppConfigPatchBodySchema>;

/** Exported for use by the module barrel; unused internally. */
export { TierSchema };
