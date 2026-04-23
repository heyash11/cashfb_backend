import type { FilterQuery, Types } from 'mongoose';
import { ConflictError, NotFoundError } from '../../shared/errors/AppError.js';
import type { AdminUserAttrs } from '../../shared/models/AdminUser.model.js';
import { AdminUserRepository } from '../../shared/repositories/AdminUser.repository.js';
import { createAdmin } from '../../shared/seed/admin-bootstrap.js';
import { AdminSessionStore, type AdminRole } from '../../shared/sessions/admin-session.store.js';

export interface AdminAdminUsersListFilter {
  role?: AdminRole;
  disabled?: boolean;
}

export interface AdminAdminUsersListResult {
  items: AdminUserAttrs[];
}

export interface CreateAdminHttpInput {
  email: string;
  password: string;
  name?: string;
  role: AdminRole;
}

export interface AdminAdminUsersServiceDeps {
  adminUserRepo?: AdminUserRepository;
  sessionStore?: AdminSessionStore;
}

/**
 * Admin CRUD over the admin_users collection itself. SUPER_ADMIN-
 * only. Deactivation is soft (disabled: true) because AuditLog
 * rows reference admin_users._id via actorId — hard delete would
 * orphan the audit trail.
 */
export class AdminAdminUsersService {
  private readonly adminUserRepo: AdminUserRepository;
  private readonly sessionStore: AdminSessionStore;

  constructor(deps: AdminAdminUsersServiceDeps = {}) {
    this.adminUserRepo = deps.adminUserRepo ?? new AdminUserRepository();
    this.sessionStore = deps.sessionStore ?? new AdminSessionStore();
  }

  async list(filter: AdminAdminUsersListFilter): Promise<AdminAdminUsersListResult> {
    const q: FilterQuery<AdminUserAttrs> = {};
    if (filter.role) q.role = filter.role;
    if (typeof filter.disabled === 'boolean') q.disabled = filter.disabled;
    const items = await this.adminUserRepo.find(q, { sort: { createdAt: -1 } });
    return { items };
  }

  async getForAudit(id: Types.ObjectId | string): Promise<AdminUserAttrs | null> {
    return this.adminUserRepo.findById(id);
  }

  /**
   * Mint a new admin via the shared bootstrap helper. Reason for
   * keeping logic in admin-bootstrap: the CLI (`pnpm admin:create`)
   * and this HTTP path share validation rules + bcrypt cost, so one
   * helper prevents drift.
   */
  async create(input: CreateAdminHttpInput): Promise<AdminUserAttrs> {
    try {
      const createArgs: Parameters<typeof createAdmin>[0] = {
        email: input.email,
        password: input.password,
        role: input.role,
      };
      if (input.name !== undefined) createArgs.name = input.name;
      const result = await createAdmin(createArgs);
      // createAdmin returns the summary — re-read the full row so
      // the audit log captures every field.
      const full = await this.adminUserRepo.findById(result.id);
      if (!full) throw new NotFoundError('Admin not found after create');
      return full;
    } catch (err) {
      if (err instanceof Error && /already exists/.test(err.message)) {
        throw new ConflictError('ADMIN_EMAIL_IN_USE', err.message);
      }
      throw err;
    }
  }

  async changeRole(id: Types.ObjectId, role: AdminRole): Promise<AdminUserAttrs> {
    const updated = await this.adminUserRepo.findOneAndUpdate({ _id: id }, { $set: { role } });
    if (!updated) throw new NotFoundError('Admin not found');
    return updated;
  }

  async toggle2fa(id: Types.ObjectId, enabled: boolean): Promise<AdminUserAttrs> {
    const updated = await this.adminUserRepo.findOneAndUpdate(
      { _id: id },
      { $set: { 'twoFactor.enabled': enabled } },
    );
    if (!updated) throw new NotFoundError('Admin not found');
    return updated;
  }

  /**
   * Hard-expire every active session for this admin. Unlike user
   * force-logout (which uses a Redis denylist against JWT iat),
   * admin sessions are Redis-native already — we destroy them
   * directly via the session store's secondary index.
   */
  async forceLogout(id: Types.ObjectId): Promise<{ destroyed: number }> {
    const admin = await this.adminUserRepo.findById(id);
    if (!admin) throw new NotFoundError('Admin not found');
    const destroyed = await this.sessionStore.destroyAllForAdmin(String(id));
    return { destroyed };
  }

  /**
   * Soft-delete via `disabled: true`. Also destroys every active
   * session so the ex-admin's open tabs 401 on next request rather
   * than idling in Redis until TTL.
   */
  async deactivate(id: Types.ObjectId): Promise<AdminUserAttrs> {
    const updated = await this.adminUserRepo.findOneAndUpdate(
      { _id: id },
      { $set: { disabled: true } },
    );
    if (!updated) throw new NotFoundError('Admin not found');
    await this.sessionStore.destroyAllForAdmin(String(id));
    return updated;
  }
}
