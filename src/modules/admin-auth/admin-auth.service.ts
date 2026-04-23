import { randomBytes } from 'node:crypto';
import bcrypt from 'bcrypt';
import { ForbiddenError, UnauthorizedError } from '../../shared/errors/AppError.js';
import { AdminUserRepository } from '../../shared/repositories/AdminUser.repository.js';
import { AppConfigRepository } from '../../shared/repositories/AppConfig.repository.js';
import {
  AdminSessionStore,
  type AdminRole,
  type AdminSession,
} from '../../shared/sessions/admin-session.store.js';

export interface LoginInput {
  email: string;
  password: string;
  totpCode?: string;
  ip: string;
  userAgent: string;
}

export interface LoginAdmin {
  id: string;
  email: string;
  role: AdminRole;
  permissions: string[];
  twoFactorEnabled: boolean;
}

export interface LoginResult {
  sessionId: string;
  csrfToken: string;
  admin: LoginAdmin;
  absoluteExpiresAt: number;
}

export interface AdminAuthServiceDeps {
  adminUserRepo?: AdminUserRepository;
  appConfigRepo?: AppConfigRepository;
  sessionStore?: AdminSessionStore;
  clock?: () => number;
}

/**
 * Admin login + session lifecycle.
 *
 * Rejection codes (all 401 unless noted):
 *   INVALID_CREDENTIALS      — email not found OR password mismatch
 *                              (same code for both to prevent user
 *                              enumeration)
 *   ADMIN_DISABLED           — admin row has disabled: true
 *   TWO_FACTOR_NOT_IMPLEMENTED — admin has 2FA enabled but Phase 8
 *                              defers the TOTP verify flow.
 *   ADMIN_IP_NOT_ALLOWED (403) — IP doesn't match AppConfig and/or
 *                              per-admin allowlist.
 *
 * Note on 2FA: per Phase 8 §8a verdict, infrastructure-only. Schema
 * accepts `totpCode` but the service refuses login for any admin
 * with `twoFactor.enabled === true` rather than attempting to
 * verify. Post-launch iteration wires otplib + enrollment.
 */
export class AdminAuthService {
  private readonly adminUserRepo: AdminUserRepository;
  private readonly appConfigRepo: AppConfigRepository;
  private readonly sessionStore: AdminSessionStore;
  private readonly clock: () => number;

  constructor(deps: AdminAuthServiceDeps = {}) {
    this.adminUserRepo = deps.adminUserRepo ?? new AdminUserRepository();
    this.appConfigRepo = deps.appConfigRepo ?? new AppConfigRepository();
    this.sessionStore = deps.sessionStore ?? new AdminSessionStore();
    this.clock = deps.clock ?? (() => Date.now());
  }

  async login(input: LoginInput): Promise<LoginResult> {
    const admin = await this.adminUserRepo.findByEmail(input.email);
    if (!admin) {
      throw new UnauthorizedError('Invalid credentials');
    }
    if (admin.disabled) {
      throw new UnauthorizedError('Admin account disabled');
    }

    const passwordOk = await bcrypt.compare(input.password, admin.passwordHash);
    if (!passwordOk) {
      throw new UnauthorizedError('Invalid credentials');
    }

    // IP allowlist: AND-intersection of AppConfig-wide and per-admin lists.
    // Empty AppConfig list = permissive (dev/staging). Per-admin list
    // refines further when set. See middleware §IP allowlist for the
    // request-level gate; this pre-check rejects early at login.
    await this.enforceIpAllowlist(input.ip, admin.ipAllowlist);

    if (admin.twoFactor.enabled) {
      // Phase 8 ships schema only; TOTP verify pipeline deferred.
      throw new ForbiddenError(
        'TWO_FACTOR_NOT_IMPLEMENTED',
        'Two-factor authentication enrollment is not yet available',
      );
    }

    const sessionId = randomBytes(32).toString('hex');
    const csrfToken = randomBytes(32).toString('hex');

    await this.sessionStore.create({
      sessionId,
      adminId: String(admin._id),
      adminEmail: admin.email,
      role: admin.role,
      permissions: admin.permissions,
      ip: input.ip,
      userAgent: input.userAgent,
      csrfToken,
    });

    await this.adminUserRepo.updateOne(
      { _id: admin._id },
      { $set: { lastLoginAt: new Date(this.clock()), lastLoginIp: input.ip } },
    );

    return {
      sessionId,
      csrfToken,
      admin: {
        id: String(admin._id),
        email: admin.email,
        role: admin.role,
        permissions: admin.permissions,
        twoFactorEnabled: admin.twoFactor.enabled,
      },
      absoluteExpiresAt: this.clock() + 4 * 60 * 60 * 1000,
    };
  }

  async logout(sessionId: string): Promise<void> {
    await this.sessionStore.destroy(sessionId);
  }

  async getCurrentAdmin(sessionId: string): Promise<LoginAdmin | null> {
    const session = await this.sessionStore.get(sessionId);
    if (!session) return null;
    return {
      id: session.adminId,
      email: session.adminEmail,
      role: session.role,
      permissions: session.permissions,
      twoFactorEnabled: false, // not carried in session payload; re-fetch if needed
    };
  }

  async rotateCsrf(sessionId: string): Promise<{ csrfToken: string } | null> {
    const newToken = randomBytes(32).toString('hex');
    const updated = await this.sessionStore.rotateCsrf(sessionId, newToken);
    return updated ? { csrfToken: newToken } : null;
  }

  /** Exposed so middleware can reuse the same AND-intersection logic. */
  async enforceIpAllowlist(requestIp: string, adminAllowlist: string[]): Promise<void> {
    const cfg = await this.appConfigRepo.findOne({ key: 'default' });
    const tenantList = cfg?.adminIpAllowlist ?? [];

    if (tenantList.length > 0 && !tenantList.includes(requestIp)) {
      throw new ForbiddenError('ADMIN_IP_NOT_ALLOWED', 'IP not in tenant allowlist', {
        rejectedBy: 'tenant',
      });
    }
    if (adminAllowlist.length > 0 && !adminAllowlist.includes(requestIp)) {
      throw new ForbiddenError('ADMIN_IP_NOT_ALLOWED', 'IP not in admin allowlist', {
        rejectedBy: 'admin',
      });
    }
  }

  /** Tests + controllers use this to compute cookie expiry hints. */
  computeAbsoluteExpiresAt(session: AdminSession): number {
    return session.absoluteExpiresAt;
  }
}
