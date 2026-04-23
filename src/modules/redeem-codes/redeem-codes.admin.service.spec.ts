import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  clearAllCollections,
  connectTestMongo,
  disconnectTestMongo,
} from '../../../test/testing/mongo.js';
import { InMemoryEncryptor } from '../../shared/encryption/in-memory.js';
import { MODELS } from '../../shared/models/index.js';
import { PostModel } from '../../shared/models/Post.model.js';
import { RedeemCodeModel } from '../../shared/models/RedeemCode.model.js';
import { RedeemCodeBatchModel } from '../../shared/models/RedeemCodeBatch.model.js';
import { AdminRedeemCodeService } from './redeem-codes.admin.service.js';

type AnyModel = { syncIndexes(): Promise<string[]> };

const HASH_SECRET = 'unit-test-hash-secret-00000000000000000000000000';

function csvFor(codes: Array<{ code: string; denomination: number }>): Buffer {
  const lines = ['code,denomination', ...codes.map((c) => `${c.code},${c.denomination}`)];
  return Buffer.from(lines.join('\n'), 'utf8');
}

async function mkPost() {
  return PostModel.create({
    title: 'Redeem Host',
    dayKey: '2026-04-23',
    scheduledAt: new Date('2026-04-23T12:00:00Z'),
    status: 'LIVE',
    coinReward: 1,
    tierRequired: 'PUBLIC',
    createdBy: new Types.ObjectId(),
  });
}

function mkSvc(): AdminRedeemCodeService {
  return new AdminRedeemCodeService({
    encryptor: new InMemoryEncryptor(),
    hashSecret: HASH_SECRET,
  });
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

describe('AdminRedeemCodeService.uploadBatch', () => {
  it('500-row upload creates one batch and 500 AVAILABLE codes with batch.count === 500', async () => {
    const svc = mkSvc();
    const admin = new Types.ObjectId();
    const rows = Array.from({ length: 500 }, (_, i) => ({
      code: `BULK-${String(i).padStart(4, '0')}`,
      denomination: 5000,
    }));

    const result = await svc.uploadBatch(
      { csvBuffer: csvFor(rows), supplierName: 'Xoxoday' },
      admin,
    );

    expect(result.inserted).toBe(500);
    expect(result.skipped).toHaveLength(0);

    const batch = await RedeemCodeBatchModel.findById(result.batchId);
    expect(batch?.count).toBe(500);
    expect(batch?.totalValue).toBe(500 * 5000);
    expect(batch?.status).toBe('STAGED');

    const codeCount = await RedeemCodeModel.countDocuments({
      batchId: result.batchId,
      status: 'AVAILABLE',
    });
    expect(codeCount).toBe(500);
  }, 60_000);

  it('flags in-file duplicates as DUPLICATE_IN_FILE; 97 inserted, 3 skipped', async () => {
    const svc = mkSvc();
    const rows = [
      ...Array.from({ length: 97 }, (_, i) => ({
        code: `UNIQ-${String(i).padStart(3, '0')}`,
        denomination: 5000,
      })),
      { code: 'UNIQ-000', denomination: 5000 },
      { code: 'UNIQ-001', denomination: 5000 },
      { code: 'UNIQ-002', denomination: 5000 },
    ];

    const result = await svc.uploadBatch(
      { csvBuffer: csvFor(rows), supplierName: 'Xoxoday' },
      new Types.ObjectId(),
    );

    expect(result.inserted).toBe(97);
    expect(result.skipped).toHaveLength(3);
    expect(result.skipped.every((s) => s.reason === 'DUPLICATE_IN_FILE')).toBe(true);
    // First-occurrence rows are NOT flagged; only the second+ appearance is.
    expect(new Set(result.skipped.map((s) => s.code))).toEqual(
      new Set(['UNIQ-000', 'UNIQ-001', 'UNIQ-002']),
    );
  });

  it('flags cross-batch duplicates as DUPLICATE_IN_DB and inserts the rest', async () => {
    const svc = mkSvc();
    const admin = new Types.ObjectId();

    await svc.uploadBatch(
      {
        csvBuffer: csvFor([
          { code: 'SHARE-A', denomination: 5000 },
          { code: 'SHARE-B', denomination: 5000 },
        ]),
        supplierName: 'Xoxoday',
      },
      admin,
    );

    const result = await svc.uploadBatch(
      {
        csvBuffer: csvFor([
          { code: 'SHARE-A', denomination: 5000 }, // dup across batch
          { code: 'SHARE-B', denomination: 5000 }, // dup across batch
          { code: 'FRESH-1', denomination: 5000 },
          { code: 'FRESH-2', denomination: 5000 },
        ]),
        supplierName: 'Xoxoday',
      },
      admin,
    );

    expect(result.inserted).toBe(2);
    expect(result.skipped).toHaveLength(2);
    expect(result.skipped.every((s) => s.reason === 'DUPLICATE_IN_DB')).toBe(true);

    const batch = await RedeemCodeBatchModel.findById(result.batchId);
    expect(batch?.count).toBe(2);
  });

  it('flags malformed rows as INVALID_FORMAT / INVALID_DENOMINATION', async () => {
    const svc = mkSvc();
    const csv = Buffer.from(
      [
        'code,denomination',
        ',5000', // empty code → INVALID_FORMAT
        'GOOD-ONE,5000',
        'BAD-DENOM,4000', // mismatched denom → INVALID_DENOMINATION
        'NAN-DENOM,abc', // non-integer → INVALID_FORMAT
      ].join('\n'),
      'utf8',
    );

    const result = await svc.uploadBatch(
      { csvBuffer: csv, supplierName: 'Xoxoday' },
      new Types.ObjectId(),
    );

    expect(result.inserted).toBe(1);
    const reasons = result.skipped.map((s) => s.reason).sort();
    expect(reasons).toEqual(['INVALID_DENOMINATION', 'INVALID_FORMAT', 'INVALID_FORMAT']);
  });

  it('throws VALIDATION_FAILED with no batch created when zero valid rows', async () => {
    const svc = mkSvc();
    const csv = Buffer.from(['code,denomination', ',0', ',0'].join('\n'), 'utf8');

    await expect(
      svc.uploadBatch({ csvBuffer: csv, supplierName: 'Xoxoday' }, new Types.ObjectId()),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    expect(await RedeemCodeBatchModel.countDocuments()).toBe(0);
  });

  it('roundtrips supplier invoice metadata through the batch row', async () => {
    const svc = mkSvc();
    const result = await svc.uploadBatch(
      {
        csvBuffer: csvFor([{ code: 'INV-1', denomination: 5000 }]),
        supplierName: 'Qwikcilver',
        supplierInvoiceNumber: 'INV-2026-001',
        supplierInvoiceUrl: 's3://cashfb/invoices/INV-2026-001.pdf',
        notes: 'April supplier order',
      },
      new Types.ObjectId(),
    );

    const batch = await RedeemCodeBatchModel.findById(result.batchId);
    expect(batch?.supplierName).toBe('Qwikcilver');
    expect(batch?.supplierInvoiceNumber).toBe('INV-2026-001');
    expect(batch?.supplierInvoiceUrl).toBe('s3://cashfb/invoices/INV-2026-001.pdf');
    expect(batch?.notes).toBe('April supplier order');
  });
});

describe('AdminRedeemCodeService.publishBatchToPost', () => {
  it('flips N AVAILABLE to PUBLISHED; when count > available, publishes remaining and flags exhausted', async () => {
    const svc = mkSvc();
    const admin = new Types.ObjectId();
    const post = await mkPost();

    const upload = await svc.uploadBatch(
      {
        csvBuffer: csvFor(
          Array.from({ length: 5 }, (_, i) => ({
            code: `PUB-${i}`,
            denomination: 5000,
          })),
        ),
        supplierName: 'Xoxoday',
      },
      admin,
    );

    const first = await svc.publishBatchToPost(
      { batchId: upload.batchId, postId: post._id, count: 3 },
      admin,
    );
    expect(first.publishedCount).toBe(3);
    expect(first.batchExhausted).toBe(false);

    const second = await svc.publishBatchToPost(
      { batchId: upload.batchId, postId: post._id, count: 10 },
      admin,
    );
    expect(second.publishedCount).toBe(2); // only 2 remained AVAILABLE
    expect(second.batchExhausted).toBe(true);

    const published = await RedeemCodeModel.find({
      batchId: upload.batchId,
      status: 'PUBLISHED',
      postId: post._id,
    });
    expect(published).toHaveLength(5);
    expect(published.every((c) => c.publishedAt instanceof Date)).toBe(true);

    const batch = await RedeemCodeBatchModel.findById(upload.batchId);
    expect(batch?.status).toBe('EXHAUSTED');
  });
});

describe('AdminRedeemCodeService.voidCode', () => {
  it('flips a COPIED code to VOID, stores voidedReason, retains firstCopiedBy for audit', async () => {
    const svc = mkSvc();
    const admin = new Types.ObjectId();
    const copier = new Types.ObjectId();
    const post = await mkPost();

    const upload = await svc.uploadBatch(
      {
        csvBuffer: csvFor([{ code: 'VOID-ME', denomination: 5000 }]),
        supplierName: 'Xoxoday',
      },
      admin,
    );
    await svc.publishBatchToPost({ batchId: upload.batchId, postId: post._id, count: 1 }, admin);

    const published = await RedeemCodeModel.findOne({ batchId: upload.batchId });
    expect(published).toBeTruthy();

    // Simulate a user having copied it.
    await RedeemCodeModel.updateOne(
      { _id: published!._id },
      { $set: { status: 'COPIED', firstCopiedBy: copier, firstCopiedAt: new Date() } },
    );

    await svc.voidCode(published!._id, 'Supplier recalled', admin);

    const after = await RedeemCodeModel.findById(published!._id);
    expect(after?.status).toBe('VOID');
    expect(after?.voidedReason).toBe('Supplier recalled');
    expect(String(after?.firstCopiedBy)).toBe(String(copier));
  });
});
