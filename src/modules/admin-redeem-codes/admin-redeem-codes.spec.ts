import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import request from 'supertest';
import { createApp } from '../../app.js';
import {
  clearAllCollections,
  connectTestMongo,
  disconnectTestMongo,
} from '../../../test/testing/mongo.js';
import { seedAdminSession } from '../../../test/testing/admin-session-seed.js';
import { AuditLogModel } from '../../shared/models/AuditLog.model.js';
import { MODELS } from '../../shared/models/index.js';
import { RedeemCodeBatchModel } from '../../shared/models/RedeemCodeBatch.model.js';
import { RedeemCodeModel } from '../../shared/models/RedeemCode.model.js';

type AnyModel = { syncIndexes(): Promise<string[]> };

function buildCsv(codes: string[], denomination = 5000): Buffer {
  const header = 'code,denomination\n';
  const rows = codes.map((c) => `${c},${denomination}`).join('\n');
  return Buffer.from(header + rows + '\n', 'utf8');
}

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

describe('admin-redeem-codes routes', () => {
  const app = createApp();

  it('POST /upload ingests a CSV and writes an audit row for CONTENT_ADMIN', async () => {
    const seed = await seedAdminSession({ role: 'CONTENT_ADMIN' });
    const csv = buildCsv(['ROUTE-UP-001', 'ROUTE-UP-002', 'ROUTE-UP-003']);

    const res = await request(app)
      .post('/api/v1/admin/redeem-codes/upload')
      .set('Cookie', seed.cookieHeader)
      .set(seed.csrfHeaderName, seed.csrfToken)
      .field('supplierName', 'Xoxoday')
      .field('denomination', '5000')
      .attach('file', csv, { filename: 'upload.csv', contentType: 'text/csv' });

    expect(res.status).toBe(200);
    expect(res.body.data.inserted).toBe(3);

    const batchId = new Types.ObjectId(res.body.data.batchId);
    const batch = await RedeemCodeBatchModel.findById(batchId);
    expect(batch).toBeTruthy();
    expect(await RedeemCodeModel.countDocuments({ batchId })).toBe(3);

    const audit = await AuditLogModel.findOne({ action: 'REDEEM_CODE_UPLOAD' });
    expect(audit).toBeTruthy();
    expect(audit?.resource?.kind).toBe('RedeemCodeBatch');
    expect(audit?.actorId.toHexString()).toBe(seed.adminId);
  });

  it('rejects 401 without session, 403 when CONTENT_ADMIN tries to void (SUPER_ADMIN only)', async () => {
    const contentAdmin = await seedAdminSession({ role: 'CONTENT_ADMIN' });
    const fakeCodeId = new Types.ObjectId().toHexString();

    const noSession = await request(app)
      .post(`/api/v1/admin/redeem-codes/${fakeCodeId}/void`)
      .send({ reason: 'test' });
    expect(noSession.status).toBe(401);

    const wrongRole = await request(app)
      .post(`/api/v1/admin/redeem-codes/${fakeCodeId}/void`)
      .set('Cookie', contentAdmin.cookieHeader)
      .set(contentAdmin.csrfHeaderName, contentAdmin.csrfToken)
      .send({ reason: 'test' });
    expect(wrongRole.status).toBe(403);
  });

  it('POST /:id/void flips status to VOID and records before/after audit (SUPER_ADMIN)', async () => {
    const seed = await seedAdminSession({ role: 'SUPER_ADMIN' });
    const batch = await RedeemCodeBatchModel.create({
      uploadedBy: new Types.ObjectId(seed.adminId),
      supplierName: 'Xoxoday',
      denomination: 5000,
      count: 1,
      status: 'STAGED',
    });
    const code = await RedeemCodeModel.create({
      batchId: batch._id,
      denomination: 5000,
      codeCt: 'ct',
      codeIv: 'iv',
      codeTag: 'tag',
      codeDekEnc: 'dek',
      codeHash: `hash-${new Types.ObjectId().toHexString()}`,
      status: 'AVAILABLE',
    });

    const res = await request(app)
      .post(`/api/v1/admin/redeem-codes/${code._id}/void`)
      .set('Cookie', seed.cookieHeader)
      .set(seed.csrfHeaderName, seed.csrfToken)
      .send({ reason: 'supplier recall' });

    expect(res.status).toBe(200);
    // Sensitive KMS-envelope fields must NOT leak into the HTTP
    // response body. `codeCt` etc. are redacted by the auditLog
    // middleware on the way out.
    expect(res.body.data.codeCt).toBe('[REDACTED]');
    expect(res.body.data.codeDekEnc).toBe('[REDACTED]');

    const reloaded = await RedeemCodeModel.findById(code._id);
    expect(reloaded?.status).toBe('VOID');

    const audit = await AuditLogModel.findOne({ action: 'REDEEM_CODE_VOID' });
    expect(audit).toBeTruthy();
    expect((audit?.before as { status?: string } | null)?.status).toBe('AVAILABLE');
    expect((audit?.after as { status?: string } | null)?.status).toBe('VOID');
    // Same redaction on the persisted audit_logs row.
    expect((audit?.before as { codeCt?: string } | null)?.codeCt).toBe('[REDACTED]');
  });
});
