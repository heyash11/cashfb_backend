/**
 * Phase 11.5 — only the sweep-filter pipeline expression remains.
 *
 * Phase 11.3's `buildDeriveTierPipelineExpr` and
 * `buildDeriveTierExpiresAtPipelineExpr` were the MongoDB mirror of
 * the JS `deriveCurrentTier` / `deriveTierExpiresAt` derivation —
 * they wrote the legacy `User.tier` and `User.tierExpiresAt`
 * denormalized fields. Phase 11.5 deleted those legacy fields, so
 * the pipeline expressions are no longer used. /me derives the
 * `currentTier` display field on read using the JS helper directly;
 * auth uses `userCanAccessTier` which reads `subscriptions[]`
 * straight off the User row.
 *
 * The sweep service still needs `buildSweepFilterPipelineExpr` to
 * remove expired entries from `subscriptions[]` via aggregation
 * pipeline updateMany.
 */

export interface DerivationPipelineOpts {
  /** Aggregation reference to the subscriptions array. Default `$subscriptions`. */
  subsRef?: string;
  /**
   * Now-instant in pipeline-expression terms. Default `'$$NOW'` (server
   * clock). Pass an aggregation literal — e.g. `{ $literal: clockDate }`
   * — to inject a deterministic clock for tests.
   */
  nowRef?: string | unknown;
}

/**
 * Pipeline stage that filters out expired entries: keeps entries
 * whose `expiresAt` is null OR `>= now`. Used by sweep service.
 */
export function buildSweepFilterPipelineExpr(opts: DerivationPipelineOpts = {}): unknown {
  const subs = opts.subsRef ?? '$subscriptions';
  const now = opts.nowRef ?? '$$NOW';
  return {
    $filter: {
      input: subs,
      as: 'this',
      cond: {
        $or: [{ $eq: ['$$this.expiresAt', null] }, { $gte: ['$$this.expiresAt', now] }],
      },
    },
  };
}
