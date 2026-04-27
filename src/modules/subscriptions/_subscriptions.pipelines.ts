/**
 * Phase 11.3 — MongoDB aggregation-pipeline expression builders that
 * mirror the canonical derivation rules in `src/shared/models/_tier.ts`
 * (`deriveCurrentTier`, `deriveTierExpiresAt`).
 *
 * The pipeline expressions live here so the `subscriptions.service.ts`
 * webhook handlers and the `sweep.service.ts` cleanup pass can perform
 * atomic-at-document-level updates of `subscriptions[]` PLUS the
 * derived `tier` and `tierExpiresAt` fields in a single round-trip.
 *
 * Drift between this MongoDB expression and the JS derivation is
 * caught by `src/shared/models/_tier-derivation-contract.spec.ts`,
 * which runs the canonical 12-row fixture matrix through both
 * implementations and asserts identical output.
 *
 * The active-entry predicate (matches `isActiveForDerivation` in
 * _tier.ts):
 *   active(entry) = entry.status === 'ACTIVE'
 *                 OR (entry.status === 'CANCELLED'
 *                     AND entry.expiresAt != null
 *                     AND entry.expiresAt > now)
 *
 * EXPIRED status NEVER counts as active (defense-in-depth for
 * delayed sweep cycles).
 */

/**
 * Reference to the array we're deriving from. Defaults to the
 * `subscriptions` field on the document being updated, but
 * sweep + activation pipelines may pass a multi-stage local
 * reference (e.g. the post-`$filter` array from the previous
 * pipeline stage) by overriding to `'$$nextSubs'` etc.
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
 * Build the per-element "is active" predicate as a Mongo expression.
 * `entryRef` is the variable holding the entry (e.g. `$$this`).
 */
function activeEntryExpr(entryRef: string, nowRef: string | unknown): unknown {
  return {
    $or: [
      { $eq: [`${entryRef}.status`, 'ACTIVE'] },
      {
        $and: [
          { $eq: [`${entryRef}.status`, 'CANCELLED'] },
          { $ne: [`${entryRef}.expiresAt`, null] },
          { $gt: [`${entryRef}.expiresAt`, nowRef] },
        ],
      },
    ],
  };
}

/**
 * Pipeline expression evaluating to the derived `tier` value:
 *   PRO_MAX if any active entry has tier=PRO_MAX
 *   PRO     if any active entry has tier=PRO
 *   PUBLIC  otherwise
 */
export function buildDeriveTierPipelineExpr(opts: DerivationPipelineOpts = {}): unknown {
  const subs = opts.subsRef ?? '$subscriptions';
  const now = opts.nowRef ?? '$$NOW';

  const isActive = activeEntryExpr('$$this', now);

  const anyActiveProMax = {
    $anyElementTrue: {
      $map: {
        input: subs,
        as: 'this',
        in: {
          $and: [{ $eq: ['$$this.tier', 'PRO_MAX'] }, isActive],
        },
      },
    },
  };
  const anyActivePro = {
    $anyElementTrue: {
      $map: {
        input: subs,
        as: 'this',
        in: {
          $and: [{ $eq: ['$$this.tier', 'PRO'] }, isActive],
        },
      },
    },
  };

  return {
    $cond: {
      if: anyActiveProMax,
      then: 'PRO_MAX',
      else: { $cond: { if: anyActivePro, then: 'PRO', else: 'PUBLIC' } },
    },
  };
}

/**
 * Pipeline expression evaluating to the derived `tierExpiresAt`:
 * the max `expiresAt` across active entries of the driving tier
 * (PRO_MAX-driven if any active PRO_MAX, else PRO-driven if any
 * active PRO, else null).
 */
export function buildDeriveTierExpiresAtPipelineExpr(opts: DerivationPipelineOpts = {}): unknown {
  const subs = opts.subsRef ?? '$subscriptions';
  const now = opts.nowRef ?? '$$NOW';

  const isActive = activeEntryExpr('$$this', now);

  const activeProMaxExpiries = {
    $map: {
      input: {
        $filter: {
          input: subs,
          as: 'this',
          cond: { $and: [{ $eq: ['$$this.tier', 'PRO_MAX'] }, isActive] },
        },
      },
      as: 'this',
      in: '$$this.expiresAt',
    },
  };
  const activeProExpiries = {
    $map: {
      input: {
        $filter: {
          input: subs,
          as: 'this',
          cond: { $and: [{ $eq: ['$$this.tier', 'PRO'] }, isActive] },
        },
      },
      as: 'this',
      in: '$$this.expiresAt',
    },
  };

  // $max of an empty array is null in Mongo; correct for our purposes.
  // For a non-empty driving tier list, $max returns the latest expiresAt.
  return {
    $cond: {
      if: { $gt: [{ $size: activeProMaxExpiries }, 0] },
      then: { $max: activeProMaxExpiries },
      else: {
        $cond: {
          if: { $gt: [{ $size: activeProExpiries }, 0] },
          then: { $max: activeProExpiries },
          else: null,
        },
      },
    },
  };
}

/**
 * Pipeline stage that filters out expired entries: keeps entries
 * whose `expiresAt` is null OR `>= now`. Matches the §A4 sweep
 * predicate. The result is intended to be assigned to
 * `$subscriptions` in a subsequent `$set` stage.
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
