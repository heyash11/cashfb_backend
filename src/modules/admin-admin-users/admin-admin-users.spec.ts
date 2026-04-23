import bcrypt from 'bcrypt';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import {
  clearAllCollections,
  connectTestMongo,
  disconnectTestMongo,
} from '../../../test/testing/mongo.js';
import { seedAdminSession } from '../../../test/testing/admin-session-seed.js';
import { AdminUserModel } from '../../shared/models/AdminUser.model.js';
import { AuditLogModel } from '../../shared/models/AuditLog.model.js';
import { MODELS } from '../../shared/models/index.js';
import { AdminSessionStore } from '../../shared/sessions/admin-session.store.js';

type AnyModel = { syncIndexes(): Promise<string[]> };

beforeAll(async () => {
  await connectTestMongo();
  await Promise.all(Object.values(MODELS).map((m) => (m as unknown as AnyModel).syncIndexes()));
}, 120_000);

afterAll(async () => {
  await disconnectTestMongo();
});

beforeEach(async () => {
  await clearAllCollections();
});

describe('admin-admin-users routes', () => {
  const app = createApp();

  it('POST / creates a new SUPPORT_ADMIN; login works with the fresh credentials', async () => {
    const seed = await seedAdminSession({ role: 'SUPER_ADMIN' });

    const create = await request(app)
      .post('/api/v1/admin/admins')
      .set('Cookie', seed.cookieHeader)
      .set(seed.csrfHeaderName, seed.csrfToken)
      .send({
        email: 'new-support@cashfb.test',
        password: 'spec-test-support-password',
        name: 'Support One',
        role: 'SUPPORT_ADMIN',
      });
    expect(create.status).toBe(200);
    expect(create.body.data.role).toBe('SUPPORT_ADMIN');
    // The auditLog middleware redacts sensitive fields in BOTH the
    // HTTP response body AND the persisted audit row. Redaction
    // replaces the value with '[REDACTED]' rather than stripping
    // the key entirely.
    expect(create.body.data.passwordHash).toBe('[REDACTED]');
    expect(create.body.data.twoFactor?.recoveryCodes).toBe('[REDACTED]');

    // Login exercises both findByEmail + bcrypt.compare against the
    // freshly-inserted row. Returns 200 only if the new admin's
    // passwordHash verifies.
    const login = await request(app)
      .post('/api/v1/admin/auth/login')
      .send({ email: 'new-support@cashfb.test', password: 'spec-test-support-password' });
    expect(login.status).toBe(200);
    expect(login.body.data.admin.role).toBe('SUPPORT_ADMIN');

    const audit = await AuditLogModel.findOne({ action: 'ADMIN_USER_CREATE' });
    expect(audit).toBeTruthy();
    // passwordHash + twoFactor.recoveryCodes redacted in the
    // persisted audit_logs row (same redactSensitive pass that
    // produced the HTTP response body).
    expect((audit?.after as { passwordHash?: string } | null)?.passwordHash).toBe('[REDACTED]');
    expect(
      (audit?.after as { twoFactor?: { recoveryCodes?: unknown } } | null)?.twoFactor
        ?.recoveryCodes,
    ).toBe('[REDACTED]');
  });

  it('PATCH /:id/role flips role and captures before/after + reason', async () => {
    const row = await AdminUserModel.create({
      email: 'role-flip@cashfb.test',
      passwordHash: await bcrypt.hash('placeholder-password-xyz', 12),
      role: 'SUPPORT_ADMIN',
      permissions: [],
      twoFactor: { enabled: false, recoveryCodes: [] },
      ipAllowlist: [],
      disabled: false,
    });
    const seed = await seedAdminSession({ role: 'SUPER_ADMIN' });

    const res = await request(app)
      .patch(`/api/v1/admin/admins/${row._id}/role`)
      .set('Cookie', seed.cookieHeader)
      .set(seed.csrfHeaderName, seed.csrfToken)
      .send({ role: 'PAYMENT_ADMIN', reason: 'promoted to payments team after training' });
    expect(res.status).toBe(200);

    const reloaded = await AdminUserModel.findById(row._id);
    expect(reloaded?.role).toBe('PAYMENT_ADMIN');

    const audit = await AuditLogModel.findOne({ action: 'ADMIN_USER_ROLE_CHANGE' });
    expect((audit?.before as { role?: string } | null)?.role).toBe('SUPPORT_ADMIN');
    expect((audit?.after as { role?: string } | null)?.role).toBe('PAYMENT_ADMIN');
  });

  it('DELETE /:id sets disabled:true AND destroys all admin sessions for that admin', async () => {
    const victim = await AdminUserModel.create({
      email: 'to-deactivate@cashfb.test',
      passwordHash: await bcrypt.hash('deactivate-test-password', 12),
      role: 'SUPPORT_ADMIN',
      permissions: [],
      twoFactor: { enabled: false, recoveryCodes: [] },
      ipAllowlist: [],
      disabled: false,
    });
    const destroySpy = vi.spyOn(AdminSessionStore.prototype, 'destroyAllForAdmin');

    const seed = await seedAdminSession({ role: 'SUPER_ADMIN' });
    const res = await request(app)
      .delete(`/api/v1/admin/admins/${victim._id}`)
      .set('Cookie', seed.cookieHeader)
      .set(seed.csrfHeaderName, seed.csrfToken)
      .send({ reason: 'policy violation — rotation required' });
    expect(res.status).toBe(200);

    // Mongo side: disabled flipped.
    const reloaded = await AdminUserModel.findById(victim._id);
    expect(reloaded?.disabled).toBe(true);

    // Session side: destroyAllForAdmin was called with the victim's ID.
    expect(destroySpy).toHaveBeenCalled();
    const calledWith = destroySpy.mock.calls.map((c) => c[0]);
    expect(calledWith).toContain(victim._id.toString());

    destroySpy.mockRestore();

    // Login is now refused at the auth service level.
    const login = await request(app)
      .post('/api/v1/admin/auth/login')
      .send({ email: 'to-deactivate@cashfb.test', password: 'deactivate-test-password' });
    expect(login.status).toBe(401);
  });
});
