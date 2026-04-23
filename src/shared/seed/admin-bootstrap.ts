import bcrypt from 'bcrypt';
import { z } from 'zod';
import { AdminUserModel, type AdminUserAttrs } from '../models/AdminUser.model.js';

/**
 * Creates the first SUPER_ADMIN for an environment. Used by the
 * `scripts/admin-create.ts` CLI entry point. Extracted here (and
 * kept under `src/shared/seed/`) so the unit spec can import it
 * inside the Vitest include path — spec files under `scripts/`
 * are not collected.
 *
 * Idempotency: re-running for the same email throws rather than
 * overwriting a deployed admin's password. Operators rotate via
 * the admin panel, not by re-running the bootstrap CLI.
 */

const BCRYPT_COST = 12;

const AdminRoleSchema = z.enum(['SUPER_ADMIN', 'CONTENT_ADMIN', 'PAYMENT_ADMIN', 'SUPPORT_ADMIN']);

const CreateAdminSchema = z.object({
  email: z.string().email(),
  password: z.string().min(12, 'Password must be at least 12 characters'),
  name: z.string().min(1).max(100).optional(),
  /** Defaults to SUPER_ADMIN so the CLI bootstrap keeps current
   *  behaviour. HTTP callers (admin-admin-users POST /admins) pass
   *  this explicitly to mint narrower roles. */
  role: AdminRoleSchema.default('SUPER_ADMIN'),
});

/** Input type — role is optional because the Zod schema defaults it
 *  to SUPER_ADMIN on parse. `z.input` (not `z.infer`) gives the
 *  pre-default shape so CLI callers can omit role without a TS
 *  error. */
export type CreateAdminInput = z.input<typeof CreateAdminSchema>;

export interface CreateAdminResult {
  id: string;
  email: string;
  role: AdminUserAttrs['role'];
}

export async function createAdmin(input: CreateAdminInput): Promise<CreateAdminResult> {
  const parsed = CreateAdminSchema.parse(input);
  const email = parsed.email.toLowerCase().trim();

  const existing = await AdminUserModel.findOne({ email }).lean();
  if (existing) {
    throw new Error(`Admin already exists: ${email}`);
  }

  const passwordHash = await bcrypt.hash(parsed.password, BCRYPT_COST);
  const admin = await AdminUserModel.create({
    email,
    passwordHash,
    name: parsed.name ?? 'Admin',
    role: parsed.role,
    permissions: [],
    twoFactor: { enabled: false, recoveryCodes: [] },
    ipAllowlist: [],
    disabled: false,
  });

  return {
    id: String(admin._id),
    email: admin.email,
    role: admin.role,
  };
}
