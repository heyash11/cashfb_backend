import { randomBytes } from 'node:crypto';
import { Types } from 'mongoose';
import { ADMIN_SESSION_COOKIE } from '../../src/shared/middleware/admin-session.js';
import { CSRF_COOKIE } from '../../src/shared/middleware/csrf.js';
import {
  AdminSessionStore,
  type AdminRole,
} from '../../src/shared/sessions/admin-session.store.js';

/**
 * Seed an admin session in Redis for integration specs. Returns the
 * bits supertest needs to pass the adminSession + csrfCheck
 * middleware chain: a Cookie header carrying both session + csrf
 * cookies, and the X-CSRF-Token header value to echo.
 *
 * Each call generates a fresh random session + csrf pair, so specs
 * that run in parallel against the shared Redis don't stomp each
 * other. Do NOT bulk-delete `admin:session:*` between tests — other
 * parallel workers will lose their sessions mid-request.
 */
export interface SeedAdminSessionInput {
  role: AdminRole;
  permissions?: string[];
  adminId?: string;
  email?: string;
}

export interface SeededAdminSession {
  sessionId: string;
  csrfToken: string;
  cookieHeader: string;
  csrfHeaderName: string;
  adminId: string;
}

export async function seedAdminSession(input: SeedAdminSessionInput): Promise<SeededAdminSession> {
  const store = new AdminSessionStore();
  const sessionId = `test-${randomBytes(8).toString('hex')}`;
  const csrfToken = `csrf-${randomBytes(16).toString('hex')}`;
  const adminId = input.adminId ?? new Types.ObjectId().toHexString();

  await store.create({
    sessionId,
    adminId,
    adminEmail: input.email ?? 'seed-admin@cashfb.test',
    role: input.role,
    permissions: input.permissions ?? [],
    ip: '127.0.0.1',
    userAgent: 'vitest',
    csrfToken,
  });

  return {
    sessionId,
    csrfToken,
    cookieHeader: `${ADMIN_SESSION_COOKIE}=${sessionId}; ${CSRF_COOKIE}=${csrfToken}`,
    csrfHeaderName: 'X-CSRF-Token',
    adminId,
  };
}
