import { type Types, type FilterQuery } from 'mongoose';
import { type Readable } from 'node:stream';
import { stringify as csvStringify } from 'csv-stringify';
import { env } from '../../config/env.js';
import { ValidationError } from '../../shared/errors/AppError.js';
import type { Encryptor } from '../../shared/encryption/envelope.js';
import { InMemoryEncryptor } from '../../shared/encryption/in-memory.js';
import { KmsEncryptor } from '../../shared/encryption/kms.js';
import type { RedeemCodeAttrs } from '../../shared/models/RedeemCode.model.js';
import { RedeemCodeModel } from '../../shared/models/RedeemCode.model.js';
import type { RedeemCodeBatchAttrs } from '../../shared/models/RedeemCodeBatch.model.js';
import { isDuplicateKeyError } from '../../shared/repositories/_base.repository.js';
import { PostRepository } from '../../shared/repositories/Post.repository.js';
import { RedeemCodeRepository } from '../../shared/repositories/RedeemCode.repository.js';
import { RedeemCodeBatchRepository } from '../../shared/repositories/RedeemCodeBatch.repository.js';
import {
  computeCodeHash,
  encryptParsedRows,
  parseRedeemCodeCsv,
  type ParsedCsvSkip,
} from './redeem-codes.csv.js';

export type SupplierName = 'Xoxoday' | 'Plum' | 'Zaggle' | 'Qwikcilver' | 'Pine Labs';

export interface UploadBatchInput {
  csvBuffer: Buffer;
  supplierName: SupplierName;
  supplierInvoiceNumber?: string;
  supplierInvoiceUrl?: string;
  denomination?: number;
  notes?: string;
}

export type UploadBatchSkipReason = ParsedCsvSkip['reason'] | 'DUPLICATE_IN_DB';

export interface UploadBatchSkip {
  row: number;
  code: string;
  reason: UploadBatchSkipReason;
}

export interface UploadBatchResult {
  batchId: Types.ObjectId;
  inserted: number;
  skipped: UploadBatchSkip[];
}

export interface PublishBatchInput {
  batchId: Types.ObjectId;
  postId: Types.ObjectId;
  count: number;
}

export interface PublishBatchResult {
  publishedCount: number;
  batchExhausted: boolean;
}

export interface ListCodesFilter {
  status?: RedeemCodeAttrs['status'];
  batchId?: Types.ObjectId;
  postId?: Types.ObjectId;
}

export interface ListCodesResult {
  items: RedeemCodeAttrs[];
  nextCursor?: string;
}

export interface AdminRedeemCodeServiceDeps {
  redeemCodeRepo?: RedeemCodeRepository;
  redeemCodeBatchRepo?: RedeemCodeBatchRepository;
  postRepo?: PostRepository;
  encryptor?: Encryptor;
  hashSecret?: string;
}

/**
 * Admin-facing redeem-code operations. Class-only in Phase 4: HTTP
 * routes + RBAC + audit-log middleware land in Phase 8 (same pattern
 * as AdminPostService). `actorId` is accepted on every mutating
 * method so the Phase 8 audit-log wiring is a signature-compatible
 * upgrade.
 */
export class AdminRedeemCodeService {
  private readonly redeemCodeRepo: RedeemCodeRepository;
  private readonly redeemCodeBatchRepo: RedeemCodeBatchRepository;
  private readonly postRepo: PostRepository;
  private readonly encryptor: Encryptor;
  private readonly hashSecret: string;

  constructor(deps: AdminRedeemCodeServiceDeps = {}) {
    this.redeemCodeRepo = deps.redeemCodeRepo ?? new RedeemCodeRepository();
    this.redeemCodeBatchRepo = deps.redeemCodeBatchRepo ?? new RedeemCodeBatchRepository();
    this.postRepo = deps.postRepo ?? new PostRepository();
    this.encryptor = deps.encryptor ?? defaultEncryptor();
    this.hashSecret = deps.hashSecret ?? defaultHashSecret();
  }

  /**
   * CSV upload → batch + encrypted rows. Partial success: invalid
   * rows and in-file duplicates are returned in `skipped[]`; the
   * batch is still created with whatever rows survived. Zero valid
   * rows throws `ValidationError` so we don't leave an orphan batch.
   *
   * Cross-batch duplicates are detected at insert time via the
   * `codeHash` unique index and reported as `DUPLICATE_IN_DB`.
   */
  async uploadBatch(input: UploadBatchInput, actorId: Types.ObjectId): Promise<UploadBatchResult> {
    const denomination = input.denomination ?? 5000;
    const parsed = parseRedeemCodeCsv(input.csvBuffer, denomination);
    const skipped: UploadBatchSkip[] = parsed.skipped.map((s) => ({ ...s }));

    if (parsed.valid.length === 0) {
      throw new ValidationError('No valid rows in CSV upload', {
        skipped: skipped as unknown as Record<string, unknown>[],
      });
    }

    // Per-row envelope encryption. ~$1 per 10k KMS requests on
    // ap-south-1 (see redeem-codes.csv.ts for full cost note).
    const encrypted = await encryptParsedRows(parsed.valid, this.encryptor, this.hashSecret);

    const batch = await this.redeemCodeBatchRepo.create({
      uploadedBy: actorId,
      supplierName: input.supplierName,
      denomination,
      count: 0,
      status: 'STAGED',
      ...(input.supplierInvoiceNumber !== undefined
        ? { supplierInvoiceNumber: input.supplierInvoiceNumber }
        : {}),
      ...(input.supplierInvoiceUrl !== undefined
        ? { supplierInvoiceUrl: input.supplierInvoiceUrl }
        : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
    } as Partial<RedeemCodeBatchAttrs>);

    let inserted = 0;
    for (const row of encrypted) {
      try {
        await this.redeemCodeRepo.create({
          batchId: batch._id,
          denomination,
          codeCt: row.ct,
          codeIv: row.iv,
          codeTag: row.tag,
          codeDekEnc: row.dekEnc,
          codeHash: row.codeHash,
          status: 'AVAILABLE',
          copyCount: 0,
        } as Partial<RedeemCodeAttrs>);
        inserted += 1;
      } catch (err) {
        if (isDuplicateKeyError(err)) {
          skipped.push({ row: row.rowNumber, code: row.code, reason: 'DUPLICATE_IN_DB' });
          continue;
        }
        throw err;
      }
    }

    await this.redeemCodeBatchRepo.updateOne(
      { _id: batch._id },
      { $set: { count: inserted, totalValue: inserted * denomination } },
    );

    return { batchId: batch._id, inserted, skipped };
  }

  /**
   * Flip up to `count` AVAILABLE codes in the batch to PUBLISHED,
   * attaching them to the given post. Uses an atomic per-code
   * `findOneAndUpdate({status: 'AVAILABLE'})` in sequence so that a
   * concurrent publish cannot over-publish the same rows. If fewer
   * rows remain AVAILABLE than requested, the method publishes what
   * it can and reports `batchExhausted: true`.
   */
  async publishBatchToPost(
    input: PublishBatchInput,
    _actorId: Types.ObjectId,
  ): Promise<PublishBatchResult> {
    const post = await this.postRepo.findById(input.postId);
    if (!post) {
      throw new ValidationError('Post not found', { postId: String(input.postId) });
    }
    const batch = await this.redeemCodeBatchRepo.findById(input.batchId);
    if (!batch) {
      throw new ValidationError('Batch not found', { batchId: String(input.batchId) });
    }

    let publishedCount = 0;
    for (let i = 0; i < input.count; i++) {
      const flipped = await this.redeemCodeRepo.findOneAndUpdate(
        { batchId: input.batchId, status: 'AVAILABLE' },
        {
          $set: {
            status: 'PUBLISHED',
            postId: input.postId,
            publishedAt: new Date(),
          },
        },
      );
      if (!flipped) break;
      publishedCount += 1;
    }

    const remaining = await this.redeemCodeRepo.count({
      batchId: input.batchId,
      status: 'AVAILABLE',
    });
    const batchExhausted = remaining === 0;

    const nextStatus: RedeemCodeBatchAttrs['status'] =
      batchExhausted && publishedCount > 0 ? 'EXHAUSTED' : 'LIVE';
    await this.redeemCodeBatchRepo.updateOne(
      { _id: input.batchId },
      { $set: { status: nextStatus } },
    );

    return { publishedCount, batchExhausted };
  }

  /**
   * Flip any code (regardless of current status) to VOID. Preserves
   * `firstCopiedBy` / `claimedBy` for audit. A voided code never
   * becomes claimable again.
   */
  async voidCode(codeId: Types.ObjectId, reason: string, _actorId: Types.ObjectId): Promise<void> {
    await this.redeemCodeRepo.updateOne(
      { _id: codeId },
      { $set: { status: 'VOID', voidedReason: reason } },
    );
  }

  async listCodes(filter: ListCodesFilter, _cursor?: string, limit = 50): Promise<ListCodesResult> {
    const q: FilterQuery<RedeemCodeAttrs> = {};
    if (filter.status) q.status = filter.status;
    if (filter.batchId) q.batchId = filter.batchId;
    if (filter.postId) q.postId = filter.postId;

    const items = await this.redeemCodeRepo.find(q, {
      sort: { createdAt: -1, _id: -1 },
      limit: Math.max(1, Math.min(200, limit)),
    });
    const result: ListCodesResult = { items };
    return result;
  }

  /**
   * Streaming CSV of every code matching the filter. Never emits
   * plaintext. Driven by a Mongoose cursor so memory is independent
   * of row count (required by SECURITY.md audit trail — admins may
   * export full history).
   */
  auditExport(filter: ListCodesFilter): Readable {
    const q: FilterQuery<RedeemCodeAttrs> = {};
    if (filter.status) q.status = filter.status;
    if (filter.batchId) q.batchId = filter.batchId;
    if (filter.postId) q.postId = filter.postId;

    const stringifier = csvStringify({
      header: true,
      columns: [
        '_id',
        'batchId',
        'status',
        'postId',
        'firstCopiedBy',
        'firstCopiedAt',
        'claimedBy',
        'claimedAt',
        'voidedReason',
        'createdAt',
      ],
    });

    const cursor = RedeemCodeModel.find(q).sort({ createdAt: -1, _id: -1 }).lean().cursor();

    (async (): Promise<void> => {
      try {
        for await (const doc of cursor) {
          const d = doc as RedeemCodeAttrs;
          const wrote = stringifier.write({
            _id: String(d._id),
            batchId: String(d.batchId),
            status: d.status,
            postId: d.postId ? String(d.postId) : '',
            firstCopiedBy: d.firstCopiedBy ? String(d.firstCopiedBy) : '',
            firstCopiedAt: d.firstCopiedAt ? d.firstCopiedAt.toISOString() : '',
            claimedBy: d.claimedBy ? String(d.claimedBy) : '',
            claimedAt: d.claimedAt ? d.claimedAt.toISOString() : '',
            voidedReason: d.voidedReason ?? '',
            createdAt: d.createdAt.toISOString(),
          });
          if (!wrote) {
            await new Promise<void>((resolve) => stringifier.once('drain', resolve));
          }
        }
        stringifier.end();
      } catch (err) {
        stringifier.destroy(err instanceof Error ? err : new Error(String(err)));
      }
    })();

    return stringifier;
  }

  /** Exposed for tests and deterministic re-uploads. */
  codeHash(normalizedCode: string): string {
    return computeCodeHash(normalizedCode, this.hashSecret);
  }

  /** Audit before-snapshot helper used by the Phase 8 auditLog middleware. */
  async getForAudit(codeId: Types.ObjectId | string): Promise<RedeemCodeAttrs | null> {
    return this.redeemCodeRepo.findById(codeId);
  }
}

function defaultEncryptor(): Encryptor {
  if (env.KMS_KEY_ID && env.AWS_REGION) {
    return new KmsEncryptor({ region: env.AWS_REGION, keyId: env.KMS_KEY_ID });
  }
  return new InMemoryEncryptor();
}

function defaultHashSecret(): string {
  return (
    env.REDEEM_CODE_HASH_SECRET ?? 'dev-redeem-hash-secret-not-for-production-0000000000000000'
  );
}
