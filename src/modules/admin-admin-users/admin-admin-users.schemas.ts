import { z } from 'zod';

const AdminRoleSchema = z.enum(['SUPER_ADMIN', 'CONTENT_ADMIN', 'PAYMENT_ADMIN', 'SUPPORT_ADMIN']);

export const AdminAdminUsersListQuerySchema = z
  .object({
    role: AdminRoleSchema.optional(),
    disabled: z.coerce.boolean().optional(),
  })
  .strict();

export const AdminAdminUsersCreateBodySchema = z
  .object({
    email: z.string().email(),
    password: z.string().min(12, 'Password must be at least 12 characters').max(200),
    name: z.string().min(1).max(100).optional(),
    role: AdminRoleSchema,
  })
  .strict();

export const AdminAdminUsersRoleChangeBodySchema = z
  .object({
    role: AdminRoleSchema,
    reason: z.string().min(10).max(500),
  })
  .strict();

export const AdminAdminUsersToggle2FaBodySchema = z
  .object({
    enabled: z.boolean(),
    reason: z.string().min(10).max(500),
  })
  .strict();

export const AdminAdminUsersForceLogoutBodySchema = z
  .object({
    reason: z.string().min(10).max(500),
  })
  .strict();

export const AdminAdminUsersDeactivateBodySchema = z
  .object({
    reason: z.string().min(10).max(500),
  })
  .strict();

export type AdminAdminUsersListQuery = z.infer<typeof AdminAdminUsersListQuerySchema>;
export type AdminAdminUsersCreateBody = z.infer<typeof AdminAdminUsersCreateBodySchema>;
export type AdminAdminUsersRoleChangeBody = z.infer<typeof AdminAdminUsersRoleChangeBodySchema>;
export type AdminAdminUsersToggle2FaBody = z.infer<typeof AdminAdminUsersToggle2FaBodySchema>;
export type AdminAdminUsersForceLogoutBody = z.infer<typeof AdminAdminUsersForceLogoutBodySchema>;
export type AdminAdminUsersDeactivateBody = z.infer<typeof AdminAdminUsersDeactivateBodySchema>;
