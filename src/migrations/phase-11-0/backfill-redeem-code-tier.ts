import { logger } from '../../config/logger.js';
import { PostModel } from '../../shared/models/Post.model.js';
import { RedeemCodeModel } from '../../shared/models/RedeemCode.model.js';
import type { Tier } from '../../shared/models/_tier.js';
import type { BackfillReport } from './backfill-vote-tier.js';

export interface RedeemCodeBackfillReport extends BackfillReport {
  /** Codes whose `postId` referenced a Post that no longer exists. */
  orphans: number;
  /** Codes with no `postId` at all (un-published, batch-only). */
  postless: number;
}

/**
 * Phase 11.0 — backfill `RedeemCode.tier` denormalized from the
 * parent `Post.tierRequired`. Two anomaly paths:
 *
 *   - postId set, parent Post missing → `tier='PUBLIC'`, log warn.
 *     Treat as PUBLIC (safest fallback — anyone can see PUBLIC).
 *   - postId not set (un-published code in a staged batch) →
 *     `tier='PUBLIC'`. The publish flow will set the correct tier
 *     on transition to status='PUBLISHED' once Phase 11.4 lands.
 *
 * Strategy: walk the distinct set of postIds among un-tiered codes,
 * fetch the corresponding Post.tierRequired in one batch, then run
 * one updateMany per tier value. Two updateManys (PRO, PRO_MAX) +
 * one final default-to-PUBLIC sweep covers all rows.
 */
export async function runBackfillRedeemCodeTier(): Promise<RedeemCodeBackfillReport> {
  const filter = { tier: { $exists: false } };
  const scanned = await RedeemCodeModel.countDocuments(filter);

  if (scanned === 0) {
    const report: RedeemCodeBackfillReport = {
      collection: 'redeem_codes',
      scanned: 0,
      updated: 0,
      skipped: 0,
      orphans: 0,
      postless: 0,
    };
    logger.info(report, '[backfill:redeem-code-tier] complete');
    return report;
  }

  // Collect distinct postIds among untiered codes. `null`/missing
  // = postless bucket.
  const postIds = await RedeemCodeModel.distinct('postId', filter);
  const realPostIds = postIds.filter((id): id is NonNullable<typeof id> => id != null);

  // Fetch parent Posts in one round-trip.
  const posts = await PostModel.find(
    { _id: { $in: realPostIds } },
    { _id: 1, tierRequired: 1 },
  ).lean();

  // Group postIds by their Post.tierRequired value.
  const idsByTier: Record<Tier, typeof realPostIds> = { PUBLIC: [], PRO: [], PRO_MAX: [] };
  const knownIds = new Set<string>();
  for (const post of posts) {
    const tier = (post.tierRequired ?? 'PUBLIC') as Tier;
    idsByTier[tier].push(post._id);
    knownIds.add(String(post._id));
  }

  // Orphans: postId set, but Post not found in our fetch.
  const orphanIds = realPostIds.filter((id) => !knownIds.has(String(id)));
  if (orphanIds.length > 0) {
    logger.warn(
      { orphanCount: orphanIds.length, orphanIds: orphanIds.map(String) },
      '[backfill:redeem-code-tier] orphan codes — postId references missing Post; defaulting to PUBLIC',
    );
  }

  // Count "postless" rows BEFORE we sweep them to PUBLIC, since
  // afterwards we can't distinguish them from rows whose parent Post
  // was tier='PUBLIC' (both end up with tier='PUBLIC' + the same
  // postId state).
  const postless = await RedeemCodeModel.countDocuments({
    tier: { $exists: false },
    $or: [{ postId: { $exists: false } }, { postId: null }],
  });

  let updated = 0;
  // 1) Tier-specific updates from real parent Posts.
  for (const tier of ['PRO', 'PRO_MAX'] as const) {
    if (idsByTier[tier].length === 0) continue;
    const res = await RedeemCodeModel.updateMany(
      { tier: { $exists: false }, postId: { $in: idsByTier[tier] } },
      { $set: { tier } },
    );
    updated += res.modifiedCount;
  }

  // 2) Sweep remainder — postless codes + orphans + Posts whose
  //    tierRequired was already 'PUBLIC' — to PUBLIC.
  const sweepRes = await RedeemCodeModel.updateMany(
    { tier: { $exists: false } },
    { $set: { tier: 'PUBLIC' } },
  );
  updated += sweepRes.modifiedCount;

  const report: RedeemCodeBackfillReport = {
    collection: 'redeem_codes',
    scanned,
    updated,
    skipped: scanned - updated,
    orphans: orphanIds.length,
    postless,
  };
  logger.info(report, '[backfill:redeem-code-tier] complete');
  return report;
}
