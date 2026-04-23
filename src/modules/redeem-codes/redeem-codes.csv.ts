import { parse } from 'csv-parse/sync';
import { createHmac } from 'node:crypto';
import type { Encryptor } from '../../shared/encryption/envelope.js';

export type SkipReason = 'DUPLICATE_IN_FILE' | 'INVALID_FORMAT' | 'INVALID_DENOMINATION';

export interface ParsedCsvRow {
  /** 1-indexed (header = row 0). */
  rowNumber: number;
  /** Normalized: trimmed + uppercased. */
  code: string;
}

export interface ParsedCsvSkip {
  row: number;
  code: string;
  reason: SkipReason;
}

export interface CsvParseResult {
  valid: ParsedCsvRow[];
  skipped: ParsedCsvSkip[];
}

export interface EncryptedRow {
  rowNumber: number;
  code: string;
  codeHash: string;
  ct: string;
  iv: string;
  tag: string;
  dekEnc: string;
}

export const DEFAULT_MAX_ROWS = 10_000;
const MAX_CODE_LENGTH = 64;

type RawRow = { code?: string; denomination?: string };

/**
 * Parse a CSV upload into encrypt-ready rows. Partial success: rows
 * that fail validation or duplicate an earlier row in the same file
 * surface in `skipped[]` with a structured reason. Cross-batch (DB)
 * duplicates are detected at insert time by the unique index on
 * `codeHash` and handled by the caller.
 *
 * Header row is required: `code,denomination`. Normalisation strips
 * whitespace and upper-cases the code before dedup and hashing.
 */
export function parseRedeemCodeCsv(
  csvBuffer: Buffer,
  batchDenomination: number,
  maxRows: number = DEFAULT_MAX_ROWS,
): CsvParseResult {
  const records = parse(csvBuffer, {
    columns: true,
    trim: true,
    skip_empty_lines: true,
    bom: true,
  }) as RawRow[];

  if (records.length > maxRows) {
    throw new Error(`CSV exceeds row cap: ${records.length} > ${maxRows}`);
  }

  const valid: ParsedCsvRow[] = [];
  const skipped: ParsedCsvSkip[] = [];
  const seenInFile = new Set<string>();

  records.forEach((raw, i) => {
    const rowNumber = i + 1;
    const codeRaw = (raw.code ?? '').toString();
    const denomRaw = (raw.denomination ?? '').toString();
    const code = codeRaw.trim().toUpperCase();

    if (!code || code.length > MAX_CODE_LENGTH) {
      skipped.push({ row: rowNumber, code: codeRaw, reason: 'INVALID_FORMAT' });
      return;
    }

    const denom = Number.parseInt(denomRaw, 10);
    if (!Number.isInteger(denom) || denom <= 0) {
      skipped.push({ row: rowNumber, code, reason: 'INVALID_FORMAT' });
      return;
    }
    if (denom !== batchDenomination) {
      skipped.push({ row: rowNumber, code, reason: 'INVALID_DENOMINATION' });
      return;
    }

    if (seenInFile.has(code)) {
      skipped.push({ row: rowNumber, code, reason: 'DUPLICATE_IN_FILE' });
      return;
    }
    seenInFile.add(code);

    valid.push({ rowNumber, code });
  });

  return { valid, skipped };
}

/**
 * Deterministic dedup digest. HMAC-SHA256 with a symmetric secret
 * (`env.REDEEM_CODE_HASH_SECRET`) — NOT a KMS DEK. DEKs are per-row
 * and randomised so they cannot be used for equality compare; a
 * symmetric HMAC lets us index on `codeHash` and reject duplicates
 * without decrypting any row.
 */
export function computeCodeHash(normalizedCode: string, secret: string): string {
  return createHmac('sha256', secret).update(normalizedCode, 'utf8').digest('hex');
}

/**
 * Encrypt the valid rows with per-row envelope encryption and compute
 * each row's dedup hash. Per SECURITY.md §3, every encrypted field
 * gets a freshly-generated DEK so a single DEK leak exposes one code,
 * not a batch.
 *
 * KMS cost note: on prod KMS, `GenerateDataKey` is ~$1 per 10k
 * requests in ap-south-1. A 500-code batch ≈ $0.05, a 10k-code
 * batch ≈ $1. Admin upload is not latency-sensitive (progress bar
 * UX). Do NOT "optimise" by sharing a DEK across rows — that breaks
 * the per-field isolation guarantee the envelope scheme exists to
 * provide.
 */
export async function encryptParsedRows(
  rows: ParsedCsvRow[],
  encryptor: Encryptor,
  hashSecret: string,
): Promise<EncryptedRow[]> {
  const out: EncryptedRow[] = [];
  for (const row of rows) {
    const field = await encryptor.encryptField(row.code);
    out.push({
      rowNumber: row.rowNumber,
      code: row.code,
      codeHash: computeCodeHash(row.code, hashSecret),
      ct: field.ct,
      iv: field.iv,
      tag: field.tag,
      dekEnc: field.dekEnc,
    });
  }
  return out;
}
