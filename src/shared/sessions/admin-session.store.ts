import type Redis from 'ioredis';
import { redis } from '../../config/redis.js';

/**
 * Redis-backed admin session store. Key schema:
 *
 *   admin:session:<sessionId>       → JSON(AdminSession), TTL = idle (30 min)
 *   admin:session:by-admin:<adminId> → Redis SET of sessionIds, no TTL
 *
 * The idle timeout rides the Redis key TTL — every `touch()` calls
 * EXPIRE. The absolute expiry is stored inside the JSON payload
 * (`absoluteExpiresAt` ms-epoch) and checked in-application at read
 * time. When the absolute expiry passes, `get()` and `touch()`
 * return null and `destroy()` clears the row.
 *
 * Force-logout-all (an admin-panel action for "terminate all my
 * sessions" or "terminate user X's sessions") reads the secondary
 * index and `DEL`s each session key.
 *
 * Sensitive: the stored value includes the CSRF token. Redis is a
 * trust-boundary secret store — same trust level as Mongo for
 * session data.
 */

export const ADMIN_SESSION_IDLE_TTL_MS = 30 * 60 * 1000; // 30 minutes
export const ADMIN_SESSION_ABSOLUTE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

export type AdminRole = 'SUPER_ADMIN' | 'CONTENT_ADMIN' | 'PAYMENT_ADMIN' | 'SUPPORT_ADMIN';

export interface AdminSession {
  sessionId: string;
  adminId: string;
  adminEmail: string;
  role: AdminRole;
  permissions: string[];
  ip: string;
  userAgent: string;
  csrfToken: string;
  createdAt: number;
  lastSeenAt: number;
  absoluteExpiresAt: number;
}

export interface CreateAdminSessionInput {
  sessionId: string;
  adminId: string;
  adminEmail: string;
  role: AdminRole;
  permissions: string[];
  ip: string;
  userAgent: string;
  csrfToken: string;
}

export interface AdminSessionStoreDeps {
  redis?: Redis;
  clock?: () => number;
  idleTtlMs?: number;
  absoluteTtlMs?: number;
}

function sessionKey(sessionId: string): string {
  return `admin:session:${sessionId}`;
}
function adminIndexKey(adminId: string): string {
  return `admin:session:by-admin:${adminId}`;
}

export class AdminSessionStore {
  private readonly redis: Redis;
  private readonly clock: () => number;
  private readonly idleTtlMs: number;
  private readonly absoluteTtlMs: number;

  constructor(deps: AdminSessionStoreDeps = {}) {
    this.redis = deps.redis ?? redis;
    this.clock = deps.clock ?? (() => Date.now());
    this.idleTtlMs = deps.idleTtlMs ?? ADMIN_SESSION_IDLE_TTL_MS;
    this.absoluteTtlMs = deps.absoluteTtlMs ?? ADMIN_SESSION_ABSOLUTE_TTL_MS;
  }

  async create(input: CreateAdminSessionInput): Promise<AdminSession> {
    const now = this.clock();
    const session: AdminSession = {
      ...input,
      createdAt: now,
      lastSeenAt: now,
      absoluteExpiresAt: now + this.absoluteTtlMs,
    };
    await this.redis.set(
      sessionKey(session.sessionId),
      JSON.stringify(session),
      'PX',
      this.idleTtlMs,
    );
    await this.redis.sadd(adminIndexKey(session.adminId), session.sessionId);
    return session;
  }

  async get(sessionId: string): Promise<AdminSession | null> {
    const raw = await this.redis.get(sessionKey(sessionId));
    if (!raw) return null;
    const session = JSON.parse(raw) as AdminSession;
    if (this.clock() >= session.absoluteExpiresAt) {
      await this.destroy(sessionId);
      return null;
    }
    return session;
  }

  /**
   * Refresh idle TTL + update lastSeenAt. Returns the updated session
   * or null if not found / absolute-expired.
   */
  async touch(sessionId: string): Promise<AdminSession | null> {
    const session = await this.get(sessionId);
    if (!session) return null;
    session.lastSeenAt = this.clock();
    await this.redis.set(sessionKey(sessionId), JSON.stringify(session), 'PX', this.idleTtlMs);
    return session;
  }

  async destroy(sessionId: string): Promise<void> {
    const raw = await this.redis.get(sessionKey(sessionId));
    if (raw) {
      const session = JSON.parse(raw) as AdminSession;
      await this.redis.srem(adminIndexKey(session.adminId), sessionId);
    }
    await this.redis.del(sessionKey(sessionId));
  }

  async destroyAllForAdmin(adminId: string): Promise<number> {
    const ids = await this.redis.smembers(adminIndexKey(adminId));
    if (ids.length === 0) return 0;
    const keys = ids.map(sessionKey);
    await this.redis.del(...keys);
    await this.redis.del(adminIndexKey(adminId));
    return ids.length;
  }

  async rotateCsrf(sessionId: string, newCsrfToken: string): Promise<AdminSession | null> {
    const session = await this.get(sessionId);
    if (!session) return null;
    session.csrfToken = newCsrfToken;
    session.lastSeenAt = this.clock();
    await this.redis.set(sessionKey(sessionId), JSON.stringify(session), 'PX', this.idleTtlMs);
    return session;
  }
}
