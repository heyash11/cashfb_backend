/**
 * Sensitive-field redaction shared by the auditLog middleware (for
 * both persisted `audit_logs` rows AND HTTP response bodies) and any
 * future observability layer that serialises resource snapshots.
 *
 * Two match modes:
 *   1. LEAF key match — a top-level key name that should be redacted
 *      wherever it appears at any nesting depth. Use this for unique
 *      field names (passwordHash, codeCt) where false-positive
 *      matches on other entities are extremely unlikely.
 *   2. DOTTED path match — exact path from the root of the value
 *      being redacted. Use this when the leaf name is generic (e.g.
 *      `secret`, `recoveryCodes`) and false-positives would matter.
 *
 * Keep this list aligned with the pino redaction policy in
 * `src/config/logger.ts`. Both serve the same purpose (prevent
 * sensitive fields from reaching an observable channel), just on
 * different emission paths.
 */

// Naming convention for future additions: fields ending in `Ct`,
// `Iv`, `Tag`, `DekEnc` indicate KMS-enveloped ciphertext components
// and should always be added to this list when new KMS-enveloped
// fields are introduced. Hash and public-id fields are non-sensitive
// and pass through.
const SENSITIVE_LEAF_KEYS: ReadonlySet<string> = new Set([
  // Admin credentials
  'passwordHash',
  // Redeem-code KMS envelope (Phase 4)
  'codeCt',
  'codeIv',
  'codeTag',
  'codeDekEnc',
  // PAN KMS envelope (Phase 8 §KYC)
  'panCt',
  'panIv',
  'panTag',
  'panDekEnc',
  // Custom-room credentials KMS envelope (Phase 6)
  'roomIdCt',
  'roomIdIv',
  'roomIdTag',
  'roomIdDekEnc',
  'roomPwdCt',
  'roomPwdIv',
  'roomPwdTag',
  'roomPwdDekEnc',
]);

const SENSITIVE_DOTTED_PATHS: ReadonlySet<string> = new Set([
  // 2FA internals — `secret` + `recoveryCodes` are too generic for
  // leaf-name matching (other collections could reuse those names
  // for benign purposes). Scoping to twoFactor.* keeps the match
  // narrow.
  'twoFactor.secret',
  'twoFactor.recoveryCodes',
]);

export const SENSITIVE_FIELD_LIST: readonly string[] = [
  ...SENSITIVE_LEAF_KEYS,
  ...SENSITIVE_DOTTED_PATHS,
];

export const REDACTED_PLACEHOLDER = '[REDACTED]' as const;

/**
 * Deep-clone `value`, replacing any sensitive field with the
 * placeholder string. Non-objects (scalars, null, undefined) pass
 * through unchanged. Arrays recurse element-wise with the array
 * element inheriting the parent path.
 *
 * Calling with no `pathPrefix` is the typical entry point — the
 * parameter is the internal recursion accumulator used to match
 * SENSITIVE_DOTTED_PATHS.
 */
export function redactSensitive(value: unknown, pathPrefix = ''): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    // Arrays don't add a path segment — elements inherit the
    // current prefix. This matches how mongo dotted paths work
    // for embedded arrays.
    return value.map((v) => redactSensitive(v, pathPrefix));
  }
  // Only recurse into plain objects. ObjectId, Date, Buffer, RegExp,
  // and any class-instance has a prototype other than Object.prototype
  // and MUST pass through unchanged — walking them would enumerate
  // internal buffer fields and corrupt serialisation (e.g. an ObjectId
  // would become `{buffer: {0: ..., 1: ...}}` and fail re-parsing).
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const fullPath = pathPrefix ? `${pathPrefix}.${k}` : k;
    if (SENSITIVE_LEAF_KEYS.has(k) || SENSITIVE_DOTTED_PATHS.has(fullPath)) {
      out[k] = REDACTED_PLACEHOLDER;
      continue;
    }
    if (v !== null && typeof v === 'object') {
      out[k] = redactSensitive(v, fullPath);
      continue;
    }
    out[k] = v;
  }
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}
