import { z } from 'zod';

export const AdminUsersListQuerySchema = z
  .object({
    search: z.string().min(1).max(200).optional(),
    tier: z.enum(['PUBLIC', 'PRO', 'PRO_MAX']).optional(),
    blocked: z.coerce.boolean().optional(),
    cursor: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

export const AdminUserBlockBodySchema = z
  .object({
    reason: z.string().min(10).max(500),
  })
  .strict();

/** Unblock takes an optional reason for the audit log. */
export const AdminUserUnblockBodySchema = z
  .object({
    reason: z.string().min(10).max(500).optional(),
  })
  .strict();

/**
 * Coin-adjust body. delta is signed: positive for credit, negative
 * for debit. reason is required and must be a meaningful explanation
 * (min 10 chars) — operators can't get away with "adjust" or "fix".
 */
export const AdminUserCoinAdjustBodySchema = z
  .object({
    delta: z
      .number()
      .int('delta must be an integer')
      .refine((v) => v !== 0, { message: 'delta must not be zero' }),
    reason: z.string().min(10).max(500),
  })
  .strict();

export const AdminUserForceLogoutBodySchema = z
  .object({
    reason: z.string().min(10).max(500),
  })
  .strict();

export const AdminUserErasureHoldBodySchema = z
  .object({
    reason: z.string().min(10).max(500),
  })
  .strict();

export const AdminUserErasureHoldClearBodySchema = z.object({}).strict();

export type AdminUsersListQuery = z.infer<typeof AdminUsersListQuerySchema>;
export type AdminUserBlockBody = z.infer<typeof AdminUserBlockBodySchema>;
export type AdminUserUnblockBody = z.infer<typeof AdminUserUnblockBodySchema>;
export type AdminUserCoinAdjustBody = z.infer<typeof AdminUserCoinAdjustBodySchema>;
export type AdminUserForceLogoutBody = z.infer<typeof AdminUserForceLogoutBodySchema>;
